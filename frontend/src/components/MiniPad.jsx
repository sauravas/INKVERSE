import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import { Smoother, coalesced, drawSegments, uid } from '../lib/ink'

/**
 * A small, unsynced handwriting strip for writing a follow-up beside a step.
 * Coordinates are its own pixel space; it exports a cropped PNG for the model.
 */
const MiniPad = forwardRef(function MiniPad({ height = 96, placeholder }, ref) {
  const cvRef = useRef(null)
  const wrapRef = useRef(null)
  const strokes = useRef([])
  const live = useRef(null)
  const smooth = useRef(null)
  const boxRef = useRef({ x: 0, y: 0, scale: 1 })

  const redraw = useCallback(() => {
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, cv.width, cv.height)
    for (const s of strokes.current) drawSegments(ctx, s, boxRef.current, 0)
    if (live.current) drawSegments(ctx, live.current, boxRef.current, 0)
  }, [])

  const resize = useCallback(() => {
    const cv = cvRef.current
    const wrap = wrapRef.current
    if (!cv || !wrap) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    cv.style.width = `${wrap.clientWidth}px`
    cv.style.height = `${height}px`
    cv.width = Math.round(wrap.clientWidth * dpr)
    cv.height = Math.round(height * dpr)
    boxRef.current = { x: 0, y: 0, scale: dpr }
    redraw()
  }, [height, redraw])

  useEffect(() => {
    resize()
    const ro = new ResizeObserver(resize)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [resize])

  const pt = (e) => {
    const r = cvRef.current.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top, e.pressure ?? 0.5,
            Math.round(performance.now())]
  }

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    smooth.current = new Smoother(0.5)
    live.current = {
      id: uid(), tool: 'pen', color: '#16213a', size: 2.0,
      hasPressure: e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5,
      pts: [smooth.current.push(pt(e))], pointerId: e.pointerId,
    }
    redraw()
  }

  const move = (e) => {
    if (!live.current || live.current.pointerId !== e.pointerId) return
    const evs = coalesced(e.nativeEvent)
    for (const ce of evs) {
      const p = smooth.current.push(pt(ce))
      const last = live.current.pts[live.current.pts.length - 1]
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.4) continue
      live.current.pts.push(p)
    }
    redraw()
  }

  const up = () => {
    if (!live.current) return
    strokes.current.push(live.current)
    live.current = null
    redraw()
  }

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokes.current.length === 0,
    clear: () => { strokes.current = []; live.current = null; redraw() },
    toPng: () => {
      if (!strokes.current.length) return null
      const pad = 16
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const s of strokes.current) {
        for (const p of s.pts) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
        }
      }
      const w = Math.max(64, maxX - minX + pad * 2)
      const h = Math.max(48, maxY - minY + pad * 2)
      const scale = 2
      const out = document.createElement('canvas')
      out.width = Math.round(w * scale)
      out.height = Math.round(h * scale)
      const ctx = out.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      const box = { x: (-minX + pad) * scale, y: (-minY + pad) * scale, scale }
      for (const s of strokes.current) drawSegments(ctx, s, box, 0)
      return out.toDataURL('image/png')
    },
  }), [redraw])

  return (
    <div ref={wrapRef} className="relative w-full">
      {placeholder && (
        <span className="pointer-events-none absolute left-3 top-2 text-xs text-ink-soft/45">
          {placeholder}
        </span>
      )}
      <canvas
        ref={cvRef}
        className="ink-surface block w-full rounded-md bg-white/80 ring-1 ring-amber-200"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={up}
      />
    </div>
  )
})

export default MiniPad
