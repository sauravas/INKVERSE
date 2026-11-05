import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react'
import {
  PAGE_H, PAGE_W, Smoother, coalesced, contentLogicalHeight, drawSegments,
  pageRect, renderAll, strokesNear, strokesToPng, toLogical, uid, widthFitBox,
} from '../lib/ink'
import { snapToRules } from '../lib/lines'

const ERASER_RADIUS = 14

/**
 * The notebook surface.
 *
 * Writing is entirely local-first: points are drawn the moment they arrive and
 * only then mirrored to the workspace. If the socket is down you can still
 * write, and nothing here waits on the AI.
 */
const InkCanvas = forwardRef(function InkCanvas(
  { sync, tool = 'pen', color = '#16213a', size = 2.4, palmRejection = true,
    onPagesChange, onInkChange, showRule = true, fitWidth = false },
  ref,
) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)

  const pagesRef = useRef([{ id: 'local', title: 'Page 1', strokes: [] }])
  const activeRef = useRef(0)
  const liveRef = useRef(new Map())       // strokeId -> stroke being drawn
  const drawnRef = useRef(new Map())      // strokeId -> points already rendered
  const baseRef = useRef(null)            // offscreen: committed strokes
  const boxRef = useRef({ x: 0, y: 0, w: 0, h: 0, scale: 1 })
  const dirtyRef = useRef(true)
  const pendingRef = useRef(new Map())    // strokeId -> points awaiting send
  const lastPenRef = useRef(0)
  const smoothRef = useRef(new Map())
  const eraseBufRef = useRef(new Set())
  const cursorsRef = useRef(new Map())
  const askedRef = useRef(false)

  const [pages, setPages] = useState([{ id: 'local', title: 'Page 1' }])
  const [active, setActive] = useState(0)
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const sizeRef = useRef(size)
  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { colorRef.current = color }, [color])
  useEffect(() => { sizeRef.current = size }, [size])

  const curPage = () => pagesRef.current[activeRef.current]

  // -- offscreen base ------------------------------------------------------
  const resizeRef = useRef(() => {})

  const paintBase = useCallback(() => {
    const base = baseRef.current
    if (!base) return
    const ctx = base.getContext('2d')
    const page = curPage()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    renderAll(ctx, page ? page.strokes : [], boxRef.current, base.width, base.height)
    dirtyRef.current = true
  }, [])

  const rebuildBase = useCallback(() => {
    // In fitWidth mode the container height tracks the ink, so a stroke being
    // added/erased/cleared can change how tall the page needs to be - refit
    // (which repaints as its last step) rather than repainting into a stale
    // size and leaving a gap or a clipped stroke.
    if (fitWidth) { resizeRef.current(); return }
    paintBase()
  }, [fitWidth, paintBase])

  const resize = useCallback(() => {
    const cv = canvasRef.current
    const wrap = wrapRef.current
    if (!cv || !wrap) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    const w = wrap.clientWidth
    // The wrap can report 0 right after mount or a view switch, before layout
    // settles. Sizing the canvas to 0 leaves a 0x0 offscreen base, and the
    // paint loop's drawImage(base, ...) throws InvalidStateError on it - skip
    // and let the next ResizeObserver tick (which fires once layout is real)
    // do the sizing instead.
    if (w < 1) return

    let h, box
    if (fitWidth) {
      const scale = w / PAGE_W
      const logicalH = contentLogicalHeight(curPage()?.strokes)
      // a whole number of ruled lines, so whatever follows starts on a rule
      h = snapToRules(logicalH * scale)
      wrap.style.height = `${h}px`           // breaks the h-full circularity
      box = widthFitBox(w)
    } else {
      h = wrap.clientHeight
      if (h < 1) return
      box = pageRect(w * dpr, h * dpr)
    }

    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)

    if (!baseRef.current) baseRef.current = document.createElement('canvas')
    baseRef.current.width = cv.width
    baseRef.current.height = cv.height

    boxRef.current = fitWidth ? { ...box, scale: box.scale * dpr } : box
    paintBase()
  }, [paintBase, fitWidth])

  useEffect(() => { resizeRef.current = resize }, [resize])

  useEffect(() => {
    resize()
    const ro = new ResizeObserver(resize)
    if (wrapRef.current) ro.observe(wrapRef.current)
    window.addEventListener('orientationchange', resize)
    return () => {
      ro.disconnect()
      window.removeEventListener('orientationchange', resize)
    }
  }, [resize])

  // -- paint loop ----------------------------------------------------------
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const cv = canvasRef.current
      const base = baseRef.current
      if (!cv || !base) return

      // flush buffered points to the workspace once per frame
      if (pendingRef.current.size) {
        for (const [id, pts] of pendingRef.current) {
          if (pts.length) sync?.send?.({ t: 'stroke_points', id, pts })
        }
        pendingRef.current.clear()
      }
      if (eraseBufRef.current.size) {
        const ids = [...eraseBufRef.current]
        eraseBufRef.current.clear()
        sync?.send?.({ t: 'erase', ids })
      }

      if (!dirtyRef.current && liveRef.current.size === 0) return
      // belt and braces: never draw from/to a 0x0 canvas
      if (cv.width < 1 || cv.height < 1 || base.width < 1 || base.height < 1) return
      const ctx = cv.getContext('2d')
      ctx.clearRect(0, 0, cv.width, cv.height)
      ctx.drawImage(base, 0, 0)
      for (const s of liveRef.current.values()) drawSegments(ctx, s, boxRef.current, 0)
      drawCursors(ctx)
      dirtyRef.current = liveRef.current.size > 0
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [sync])

  const drawCursors = (ctx) => {
    const now = performance.now()
    for (const [id, c] of cursorsRef.current) {
      if (now - c.ts > 1500) { cursorsRef.current.delete(id); continue }
      const box = boxRef.current
      const x = box.x + c.x * box.scale
      const y = box.y + c.y * box.scale
      ctx.save()
      ctx.globalAlpha = 0.7
      ctx.fillStyle = c.role === 'phone' ? '#2f6fed' : '#15803d'
      ctx.beginPath()
      ctx.arc(x, y, 5 * (window.devicePixelRatio || 1), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      dirtyRef.current = true
    }
  }

  // -- workspace events ----------------------------------------------------
  useEffect(() => {
    if (!sync?.on) return
    const applySnapshot = (snap) => {
      pagesRef.current = snap.pages.map((p) => ({ ...p, strokes: p.strokes || [] }))
      activeRef.current = Math.min(snap.active ?? 0, pagesRef.current.length - 1)
      setPages(pagesRef.current.map((p) => ({ id: p.id, title: p.title })))
      setActive(activeRef.current)
      liveRef.current.clear()
      rebuildBase()
      onInkChange?.(curPage()?.strokes.length ?? 0)
    }

    // The socket outlives this component (switching to the dashboard and back
    // remounts it), so ask for the current page state rather than waiting for
    // a 'welcome' that has already been sent. Once per mount, never in a loop.
    if (!askedRef.current) {
      askedRef.current = true
      sync.send?.({ t: 'snapshot_request' })
    }

    return sync.on((m) => {
      switch (m.t) {
        case 'welcome':
          applySnapshot(m.snapshot)
          break
        case 'pages':
          applySnapshot(m.snapshot)
          break
        case 'page_select': {
          activeRef.current = m.index
          setActive(m.index)
          liveRef.current.clear()
          rebuildBase()
          onInkChange?.(curPage()?.strokes.length ?? 0)
          break
        }
        case 'stroke_begin': {
          const s = {
            id: m.id, pageId: m.pageId, tool: m.tool, color: m.color,
            size: m.size, pts: m.pts || [], hasPressure: !!m.hasPressure,
            remote: true,
          }
          liveRef.current.set(s.id, s)
          dirtyRef.current = true
          break
        }
        case 'stroke_points': {
          const s = liveRef.current.get(m.id)
          if (s) { s.pts.push(...(m.pts || [])); dirtyRef.current = true }
          break
        }
        case 'stroke_end': {
          const s = liveRef.current.get(m.id)
          if (!s) break
          if (m.pts) s.pts.push(...m.pts)
          liveRef.current.delete(m.id)
          const page = pagesRef.current.find((p) => p.id === s.pageId)
          if (page) {
            page.strokes.push(s)
            if (page.id === curPage()?.id) {
              drawSegments(baseRef.current.getContext('2d'), s, boxRef.current, 0)
            }
          }
          dirtyRef.current = true
          onInkChange?.(curPage()?.strokes.length ?? 0)
          break
        }
        case 'erase': {
          const ids = new Set(m.ids || [])
          for (const p of pagesRef.current) {
            p.strokes = p.strokes.filter((s) => !ids.has(s.id))
          }
          for (const id of ids) liveRef.current.delete(id)
          rebuildBase()
          onInkChange?.(curPage()?.strokes.length ?? 0)
          break
        }
        case 'restore': {
          for (const s of m.strokes || []) {
            const page = pagesRef.current.find((p) => p.id === s.pageId)
            if (page && !page.strokes.some((x) => x.id === s.id)) page.strokes.push(s)
          }
          rebuildBase()
          onInkChange?.(curPage()?.strokes.length ?? 0)
          break
        }
        case 'clear': {
          const page = pagesRef.current.find((p) => p.id === m.pageId)
          if (page) page.strokes = []
          rebuildBase()
          onInkChange?.(0)
          break
        }
        case 'cursor':
          cursorsRef.current.set(m.author,
            { x: m.x, y: m.y, role: m.role, ts: performance.now() })
          dirtyRef.current = true
          break
        default:
          break
      }
    })
  }, [sync, rebuildBase, onInkChange])

  useEffect(() => { onPagesChange?.(pages, active) }, [pages, active, onPagesChange])

  // -- pointer input -------------------------------------------------------
  const pointFrom = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const dpr = canvasRef.current.width / rect.width
    const box = boxRef.current
    const x = ((e.clientX - rect.left) * dpr - box.x) / box.scale
    const y = ((e.clientY - rect.top) * dpr - box.y) / box.scale
    return [x, y, e.pressure ?? 0, Math.round(performance.now())]
  }, [])

  const shouldIgnore = useCallback((e) => {
    if (e.pointerType === 'pen') { lastPenRef.current = performance.now(); return false }
    // palm rejection: once a pen is in use, ignore touch for a short window
    if (palmRejection && e.pointerType === 'touch' &&
        performance.now() - lastPenRef.current < 1800) return true
    return false
  }, [palmRejection])

  const isEraserInput = (e) =>
    toolRef.current === 'eraser' || (e.pointerType === 'pen' && (e.buttons & 32) !== 0)

  const eraseAt = useCallback((pt) => {
    const page = curPage()
    if (!page) return
    const hits = strokesNear(page.strokes, pt[0], pt[1], ERASER_RADIUS)
    if (!hits.length) return
    const hitSet = new Set(hits)
    page.strokes = page.strokes.filter((s) => !hitSet.has(s.id))
    for (const id of hits) eraseBufRef.current.add(id)
    rebuildBase()
    onInkChange?.(page.strokes.length)
  }, [rebuildBase, onInkChange])

  const onPointerDown = useCallback((e) => {
    if (shouldIgnore(e)) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)

    const pt = pointFrom(e)
    if (isEraserInput(e)) {
      eraseBufRef.current.clear()
      eraseAt(pt)
      liveRef.current.set(`erase-${e.pointerId}`, {
        id: `erase-${e.pointerId}`, erasing: true, pts: [], tool: 'eraser',
      })
      return
    }

    const sm = new Smoother(e.pointerType === 'pen' ? 0.55 : 0.4)
    smoothRef.current.set(e.pointerId, sm)
    const first = sm.push(pt)
    const hasPressure = e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5

    const stroke = {
      id: uid(), pageId: curPage()?.id, tool: toolRef.current,
      color: colorRef.current, size: sizeRef.current,
      pts: [first], hasPressure, pointerId: e.pointerId,
    }
    liveRef.current.set(stroke.id, stroke)
    drawnRef.current.set(stroke.id, 1)
    dirtyRef.current = true

    sync?.send?.({
      t: 'stroke_begin', id: stroke.id, pageId: stroke.pageId,
      tool: stroke.tool, color: stroke.color, size: stroke.size,
      hasPressure, pts: [first],
    })
  }, [eraseAt, pointFrom, shouldIgnore, sync])

  const onPointerMove = useCallback((e) => {
    if (shouldIgnore(e)) return

    const erasing = liveRef.current.get(`erase-${e.pointerId}`)
    if (erasing) {
      const evs = coalesced(e.nativeEvent)
      for (const ce of evs) eraseAt(pointFrom(ce))
      return
    }

    const stroke = [...liveRef.current.values()]
      .find((s) => s.pointerId === e.pointerId)
    if (!stroke) {
      if (sync?.send && e.pointerType !== 'touch') {
        const pt = pointFrom(e)
        sync.send({ t: 'cursor', x: pt[0], y: pt[1], down: false })
      }
      return
    }

    const sm = smoothRef.current.get(e.pointerId)
    const evs = coalesced(e.nativeEvent)
    const added = []
    for (const ce of evs) {
      const raw = pointFrom(ce)
      if (!stroke.hasPressure && ce.pointerType === 'pen' &&
          ce.pressure > 0 && ce.pressure !== 0.5) stroke.hasPressure = true
      const pt = sm ? sm.push(raw) : raw
      const last = stroke.pts[stroke.pts.length - 1]
      // drop sub-pixel noise, keep the point count sane over long strokes
      if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.45) continue
      stroke.pts.push(pt)
      added.push(pt)
    }
    if (added.length) {
      const buf = pendingRef.current.get(stroke.id) || []
      buf.push(...added)
      pendingRef.current.set(stroke.id, buf)
      dirtyRef.current = true
    }
  }, [eraseAt, pointFrom, shouldIgnore, sync])

  const endStroke = useCallback((e) => {
    const eraseKey = `erase-${e.pointerId}`
    if (liveRef.current.has(eraseKey)) {
      liveRef.current.delete(eraseKey)
      return
    }
    const stroke = [...liveRef.current.values()]
      .find((s) => s.pointerId === e.pointerId)
    if (!stroke) return

    liveRef.current.delete(stroke.id)
    smoothRef.current.delete(e.pointerId)
    drawnRef.current.delete(stroke.id)

    const page = pagesRef.current.find((p) => p.id === stroke.pageId)
    if (page) {
      page.strokes.push(stroke)
      // In fitWidth mode the page may need to grow to fit this stroke: the
      // server never echoes a stroke back to the client that sent it, so
      // without this, only strokes from a REMOTE peer (the websocket
      // handler's own rebuildBase() calls) would ever trigger a refit, and
      // the local writer's own ink could grow past the visible box uncounted.
      if (fitWidth && page.id === curPage()?.id) {
        rebuildBase()
      } else {
        drawSegments(baseRef.current.getContext('2d'), stroke, boxRef.current, 0)
      }
    }
    dirtyRef.current = true

    const tail = pendingRef.current.get(stroke.id) || []
    pendingRef.current.delete(stroke.id)
    sync?.send?.({ t: 'stroke_end', id: stroke.id, pts: tail })
    onInkChange?.(page ? page.strokes.length : 0)
  }, [sync, onInkChange, fitWidth, rebuildBase])

  // -- imperative API ------------------------------------------------------
  useImperativeHandle(ref, () => ({
    getStrokes: () => curPage()?.strokes ?? [],
    getPageId: () => curPage()?.id,
    inkCount: () => curPage()?.strokes.length ?? 0,
    toPng: (opts) => strokesToPng(curPage()?.strokes ?? [], opts),
    undo: () => sync?.send?.({ t: 'undo' }),
    redo: () => sync?.send?.({ t: 'redo' }),
    clear: () => sync?.send?.({ t: 'clear', pageId: curPage()?.id }),
    addPage: () => sync?.send?.({ t: 'page_add' }),
    selectPage: (i) => sync?.send?.({ t: 'page_select', index: i }),
    deletePage: (i) => sync?.send?.({ t: 'page_delete', index: i }),
  }), [sync])

  return (
    <div ref={wrapRef}
         className={`relative w-full overflow-hidden ${fitWidth ? '' : 'h-full'}`}>
      {showRule && <PaperBackdrop box={boxRef} />}
      <canvas
        ref={canvasRef}
        className="ink-surface absolute inset-0 h-full w-full"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={endStroke}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  )
})

/** Ruled paper drawn behind the canvas so it costs nothing to redraw. */
function PaperBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        className="ruled h-full shadow-[0_2px_24px_rgba(28,25,18,0.13)] ring-1 ring-paper-edge"
        style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}`, maxHeight: '100%', maxWidth: '100%' }}
      >
        <div className="ml-[9%] h-full border-l-2 border-margin/70" />
      </div>
    </div>
  )
}

export default InkCanvas
