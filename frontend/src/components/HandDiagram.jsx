import * as dagreNs from '@dagrejs/dagre'
import rough from 'roughjs'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { snapToRules } from '../lib/lines'

/**
 * A diagram drawn by hand.
 *
 * Input is the validated edge-list structure from the backend
 * ({title, direction, nodes, edges}); nothing here comes from model text.
 * dagre decides where blocks go, rough.js makes every line slightly
 * imperfect, and the whole thing is drawn the way a person would: a block,
 * its label, an arrow out of it, the next block - each stroke traced along
 * its own path. Edge labels and the caption are written in as pencil notes
 * around the drawing.
 */

const dagre = dagreNs.default ?? dagreNs
const INK = '#16213a'
const PENCIL = '#3451b2'
const FONT = "'Caveat', 'Segoe Script', cursive"
const LABEL_PX = 21
const EDGE_PX = 17
const LINE_H = 23
const CAPTION_H = 40

// pen timing, in ms
const T_BOX = 420
const T_EDGE = 380
const T_HEAD = 150
const T_CHAR = 36
const T_GAP = 70

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function jitter(seed, i) {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function wrapLabel(label, max = 16) {
  const words = label.split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 3)
}

let measureCtx = null
function textWidth(text, px) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = `500 ${px}px ${FONT}`
  return measureCtx.measureText(text).width || text.length * px * 0.45
}

/** The order a person would draw it in: a block, an arrow out, the next block. */
function drawingOrder(d) {
  const out = new Map(d.nodes.map((n) => [n.id, []]))
  const indeg = new Map(d.nodes.map((n) => [n.id, 0]))
  d.edges.forEach((e, i) => { out.get(e.from)?.push(i); indeg.set(e.to, (indeg.get(e.to) || 0) + 1) })
  const roots = d.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id)
  const seq = []
  const seenN = new Set()
  const seenE = new Set()
  const visit = (id) => {
    if (seenN.has(id)) return
    seenN.add(id)
    seq.push({ kind: 'node', id })
    for (const i of out.get(id) || []) {
      if (seenE.has(i)) continue
      seenE.add(i)
      seq.push({ kind: 'edge', i })
      visit(d.edges[i].to)
    }
  }
  ;(roots.length ? roots : [d.nodes[0].id]).forEach(visit)
  d.nodes.forEach((n) => visit(n.id))
  d.edges.forEach((_, i) => { if (!seenE.has(i)) { seenE.add(i); seq.push({ kind: 'edge', i }) } })
  return seq
}

function labelledHub(d) {
  return d.kind === 'labelled' ? d.edges[0]?.from : null
}

/** When each stroke starts and how long it takes. Depends only on the data. */
export function diagramTimeline(d) {
  if (d.kind === 'figure' && d.figure) return figureTimeline(d)
  const at = { nodes: {}, edges: {} }
  const hub = labelledHub(d)
  let t = 0
  const capChars = d.title.length + 6
  at.caption = { t, d: capChars * T_CHAR }
  at.underline = { t: t + capChars * T_CHAR, d: 320 }
  t += capChars * T_CHAR + 200
  for (const item of drawingOrder(d)) {
    if (item.kind === 'node') {
      const n = d.nodes.find((x) => x.id === item.id)
      const write = Math.max(220, n.label.length * T_CHAR)
      // a labelled figure's parts are just written, with no box drawn round them
      const box = hub && item.id !== hub ? 0 : T_BOX
      at.nodes[item.id] = { box: { t, d: box }, label: { t: t + box * 0.7, d: write } }
      t += box * 0.7 + write + T_GAP
    } else {
      const e = d.edges[item.i]
      const write = e.label ? Math.max(180, e.label.length * T_CHAR * 0.85) : 0
      at.edges[item.i] = {
        line: { t, d: T_EDGE }, head: { t: t + T_EDGE, d: T_HEAD },
        label: { t: t + T_EDGE + T_HEAD, d: write },
      }
      t += T_EDGE + T_HEAD + write + T_GAP
    }
  }
  if (hub) {
    // in a labelled figure, what a part does is written under its name, after it
    for (const [i, e] of d.edges.entries()) {
      const name = at.nodes[e.to]?.label
      if (name && e.label) {
        at.edges[i].label = { t: name.t + name.d, d: at.edges[i].label.d }
        t = Math.max(t, name.t + name.d + at.edges[i].label.d + T_GAP)
      }
    }
  }
  return { at, total: t }
}

function measureNodes(d) {
  return d.nodes.map((n) => {
    const lines = wrapLabel(n.label)
    const tw = Math.max(...lines.map((l) => textWidth(l, LABEL_PX)))
    let w = tw + 30
    let h = lines.length * LINE_H + 18
    if (n.shape === 'diamond') { w = w * 1.45 + 10; h = h * 1.55 }
    if (n.shape === 'circle') { w = h = Math.max(w, h) + 6 }
    if (n.shape === 'store') h += 14
    return { ...n, lines, w, h, width: w, height: h }
  })
}

/** Stages of a cycle on a ring, joined by arrows that follow the ring. */
function cycleLayout(d) {
  const sized = measureNodes(d)
  const byId = Object.fromEntries(sized.map((n) => [n.id, n]))
  const next = Object.fromEntries(d.edges.map((e) => [e.from, e.to]))
  const order = []
  for (let id = d.nodes[0].id; !order.includes(id); id = next[id]) order.push(id)
  const k = order.length
  const span = order.reduce((s, id) => s + Math.max(byId[id].w, byId[id].h), 0)
  const R = Math.max(95, (span + k * 46) / (2 * Math.PI))
  const maxW = Math.max(...sized.map((n) => n.w))
  const maxH = Math.max(...sized.map((n) => n.h))
  const cx = R + maxW / 2 + 30
  const cy = R + maxH / 2 + 22
  const angle = {}
  order.forEach((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / k
    angle[id] = a
    Object.assign(byId[id], { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) })
  })
  const gap = (id) => (Math.max(byId[id].w, byId[id].h) / 2 + 10) / R
  const edges = d.edges.map((e, i) => {
    const a0 = angle[e.from]
    let a1 = angle[e.to]
    if (a1 <= a0) a1 += 2 * Math.PI
    const from = a0 + gap(e.from)
    const to = a1 - gap(e.to)
    const pts = [0, 0.5, 1].map((f) => {
      const a = from + (to - from) * f
      const r = R * (f === 0.5 ? 1.1 : 1)          // bow outwards, like a hand-drawn arc
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
    })
    const mid = (from + to) / 2
    const lw = e.label ? textWidth(e.label, EDGE_PX) + 10 : 0
    return { ...e, i, points: pts, width: lw, x: cx + R * 1.28 * Math.cos(mid),
             y: cy + R * 1.28 * Math.sin(mid) }
  })
  const pad = Math.max(...edges.map((e) => e.width), 40)
  return { nodes: sized, edges, arrows: true,
           width: 2 * cx + pad, height: 2 * cy + CAPTION_H }
}

/** One object in the middle, its parts named on either side with leader lines. */
function labelledLayout(d) {
  const hubId = d.edges[0].from
  const sized = measureNodes(d)
  const hub = sized.find((n) => n.id === hubId)
  hub.shape = hub.shape === 'box' ? 'circle' : hub.shape
  hub.width = hub.w = Math.max(hub.w, 120) * 1.15
  hub.height = hub.h = Math.max(hub.h * 1.6, 90)
  const parts = d.edges.map((e) => sized.find((n) => n.id === e.to))
  const sides = [[], []]
  parts.forEach((pn, i) => sides[i % 2].push(pn))
  const rowH = 58
  const colW = Math.max(...parts.map((pn) => Math.max(pn.w,
    textWidth(d.edges.find((e) => e.to === pn.id)?.label || '', EDGE_PX) + 12)))
  const leader = 58
  const height = Math.max(hub.height + 30, Math.max(sides[0].length, sides[1].length) * rowH + 20)
  const cx = colW + leader + hub.width / 2 + 16
  const cy = height / 2 + 6
  Object.assign(hub, { x: cx, y: cy })
  sides.forEach((list, side) => {
    const top = cy - ((list.length - 1) * rowH) / 2
    list.forEach((pn, j) => {
      const dir = side === 0 ? 1 : -1                    // right column, then left
      Object.assign(pn, { shape: 'note', side: dir,
        x: cx + dir * (hub.width / 2 + leader + pn.w / 2), y: top + j * rowH - 6 })
    })
  })
  const edges = d.edges.map((e, i) => {
    const pn = sized.find((n) => n.id === e.to)
    const ax = pn.x - pn.side * (pn.w / 2 + 4)
    const ay = pn.y
    // where the leader meets the object's outline
    const vx = ax - cx
    const vy = ay - cy
    const t = 1 / Math.sqrt((vx / (hub.width / 2)) ** 2 + (vy / (hub.height / 2)) ** 2)
    return { ...e, i, points: [{ x: cx + vx * t, y: cy + vy * t }, { x: ax, y: ay }],
             width: e.label ? textWidth(e.label, EDGE_PX) + 10 : 0,
             x: pn.x, y: pn.y + 21, note: true }
  })
  return { nodes: sized, edges, arrows: false, width: 2 * cx, height: height + CAPTION_H }
}


// ---------------------------------------------------------------- figures
// A figure is a real drawing - a heart, a neuron - whose geometry came from
// the backend's library, not from the model. Here it only has to be placed:
// the drawing in the middle, its labels in the two margins, a leader line
// from each label to the point it names.
const FIG_GUTTER = 58
const FIG_GAP = 10
const T_OUT = 300          // one outline stroke
const T_OUT_STEP = 170     // and how soon the next one starts

/** Push labels apart so none overlaps, keeping each as near its part as it can. */
function stackColumn(items) {
  items.sort((a, b) => a.want - b.want)
  let floor = 0
  for (const it of items) {
    const top = Math.max(it.want - it.h / 2, floor)
    it.y = top + it.h / 2
    floor = top + it.h + FIG_GAP
  }
  return floor
}

function figureLayout(d) {
  const f = d.figure
  const cols = { L: [], R: [] }
  f.parts.forEach((p, i) => {
    const lines = wrapLabel(p.label, 15)
    const noteW = p.note ? textWidth(p.note, EDGE_PX) + 12 : 0
    // each glyph is tilted a little as it is written, which makes the line
    // slightly wider than a flat measurement of it: without the allowance the
    // last letter of the longest label hangs off the edge of the figure
    const w = Math.max(...lines.map((l) => textWidth(l, LABEL_PX)), noteW) * 1.04 + 12
    cols[p.side === 'R' ? 'R' : 'L'].push({
      id: `p${i}`, i, label: p.label, note: p.note, shape: 'note', lines,
      side: p.side === 'R' ? 1 : -1, anchor: p, want: p.y,
      w, width: w, h: lines.length * LINE_H + (p.note ? LINE_H : 0) + 8,
    })
  })
  cols.L.forEach((n) => { n.height = n.h })
  cols.R.forEach((n) => { n.height = n.h })
  const colW = (list) => (list.length ? Math.max(...list.map((n) => n.w)) : 0)
  const wL = colW(cols.L)
  const wR = colW(cols.R)
  const bottom = Math.max(stackColumn(cols.L), stackColumn(cols.R))

  const figX = wL + FIG_GUTTER
  const height = Math.max(f.box.h, bottom) + 8
  const figY = (height - f.box.h) / 2        // the drawing sits centred
  cols.L.forEach((n) => { n.x = wL / 2 })
  cols.R.forEach((n) => { n.x = figX + f.box.w + FIG_GUTTER + wR / 2 })
  const nodes = [...cols.L, ...cols.R]
  nodes.forEach((n) => { n.y += 0 })

  const edges = nodes.map((n) => ({
    i: n.i, from: 'figure', to: n.id, label: n.note, note: true,
    // From the point it names out to its label, with the short horizontal
    // run next to the label that a textbook leader has: a single long
    // diagonal into the middle of the drawing makes a starburst.
    points: [{ x: figX + n.anchor.x, y: figY + n.anchor.y },
             { x: n.x - n.side * (n.w / 2 + 24), y: n.y - (n.note ? LINE_H / 2 : 0) },
             { x: n.x - n.side * (n.w / 2 + 6), y: n.y - (n.note ? LINE_H / 2 : 0) }],
    width: n.note ? textWidth(n.note, EDGE_PX) + 10 : 0,
    x: n.x, y: n.y + (n.lines.length * LINE_H) / 2 + 2,
  }))
  return {
    nodes, edges, arrows: false, figure: f, figX, figY,
    width: figX + f.box.w + FIG_GUTTER + wR, height: height + CAPTION_H,
  }
}

/** The outline first, stroke by stroke, then each label with its leader. */
function figureTimeline(d) {
  const at = { nodes: {}, edges: {}, outline: [] }
  const capChars = d.title.length + 6
  at.caption = { t: 0, d: capChars * T_CHAR }
  at.underline = { t: capChars * T_CHAR, d: 320 }
  let t = capChars * T_CHAR + 200
  d.figure.strokes.forEach((_, i) => {
    at.outline.push({ t: t + i * T_OUT_STEP, d: T_OUT })
  })
  t += (d.figure.strokes.length - 1) * T_OUT_STEP + T_OUT + 260
  d.figure.parts.forEach((p, i) => {
    const write = Math.max(220, p.label.length * T_CHAR)
    const note = p.note ? Math.max(180, p.note.length * T_CHAR * 0.85) : 0
    at.nodes[`p${i}`] = { box: { t, d: 0 }, label: { t: t + T_EDGE * 0.6, d: write } }
    at.edges[i] = {
      line: { t, d: T_EDGE }, head: { t: t + T_EDGE * 0.5, d: T_HEAD },
      label: { t: t + T_EDGE * 0.6 + write, d: note },
    }
    t += T_EDGE * 0.6 + write + note + T_GAP
  })
  return { at, total: t }
}

function layout(d) {
  if (d.kind === 'figure' && d.figure) {
    try { return figureLayout(d) } catch { /* fall back to a layered layout */ }
  }
  if (d.kind === 'cycle') {
    try { return cycleLayout(d) } catch { /* fall back to a layered layout */ }
  }
  if (d.kind === 'labelled') {
    try { return labelledLayout(d) } catch { /* fall back to a layered layout */ }
  }
  return layeredLayout(d)
}

function layeredLayout(d) {
  const g = new dagre.graphlib.Graph({ multigraph: true })
  const lr = d.direction === 'LR' || d.direction === 'RL'
  g.setGraph({ rankdir: d.direction, nodesep: lr ? 34 : 46, ranksep: lr ? 74 : 58,
               edgesep: 18, marginx: 18, marginy: 14 })
  g.setDefaultEdgeLabel(() => ({}))
  const nodes = measureNodes(d)
  nodes.forEach((n) => g.setNode(n.id, { width: n.w, height: n.h }))
  d.edges.forEach((e, i) => {
    const lw = e.label ? textWidth(e.label, EDGE_PX) + 10 : 0
    g.setEdge(e.from, e.to, { width: lw, height: e.label ? 20 : 0, labelpos: 'c' }, `e${i}`)
  })
  dagre.layout(g)
  const placed = nodes.map((n) => ({ ...n, ...g.node(n.id) }))
  const edges = d.edges.map((e, i) => ({ ...e, i, ...g.edge({ v: e.from, w: e.to, name: `e${i}` }) }))
  const { width = 200, height = 100 } = g.graph()
  return { nodes: placed, edges, arrows: true,
           width: Math.max(width, textWidth(d.title, 22) + 60), height: height + CAPTION_H }
}

function shapePaths(gen, n, seed) {
  if (n.shape === 'note') return []
  const o = { seed, roughness: 1.35, bowing: 1.15, stroke: INK, strokeWidth: 1.7 }
  const x = n.x - n.width / 2
  const y = n.y - n.height / 2 + CAPTION_H
  const cx = n.x
  const cy = n.y + CAPTION_H
  let drawable
  if (n.shape === 'diamond') {
    drawable = gen.polygon([[cx, y], [x + n.width, cy], [cx, y + n.height], [x, cy]], o)
  } else if (n.shape === 'circle') {
    drawable = gen.ellipse(cx, cy, n.width, n.height, o)
  } else if (n.shape === 'round') {
    const r = Math.min(14, n.height / 2)
    const w = n.width
    const h = n.height
    drawable = gen.path(`M${x + r},${y} h${w - 2 * r} q${r},0 ${r},${r} v${h - 2 * r} `
      + `q0,${r} -${r},${r} h-${w - 2 * r} q-${r},0 -${r},-${r} v-${h - 2 * r} q0,-${r} ${r},-${r} Z`, o)
  } else if (n.shape === 'store') {
    const rx = n.width / 2
    const ry = 7
    const x1 = x + n.width
    drawable = gen.path(`M${x},${y + ry} A${rx},${ry} 0 0 0 ${x1},${y + ry} `
      + `A${rx},${ry} 0 0 0 ${x},${y + ry} L${x},${y + n.height - ry} `
      + `A${rx},${ry} 0 0 0 ${x1},${y + n.height - ry} L${x1},${y + ry}`, o)
  } else {
    drawable = gen.rectangle(x, y, n.width, n.height, o)
  }
  return gen.toPaths(drawable)
}

function edgePaths(gen, e, seed, arrows = true) {
  const pts = (e.points || []).map((p) => [p.x, p.y + CAPTION_H])
  if (pts.length < 2) return { line: [], head: [] }
  const o = { seed, roughness: 1.1, bowing: 1.4, stroke: INK, strokeWidth: 1.5 }
  const line = gen.toPaths(pts.length > 2 ? gen.curve(pts, o) : gen.line(...pts[0], ...pts[1], o))
  if (!arrows) {
    const [dx, dy] = pts[0]
    return { line, head: gen.toPaths(gen.circle(dx, dy, 6,
      { ...o, seed: seed + 1, roughness: 0.6, fill: INK, fillStyle: 'solid' })) }
  }
  // an arrowhead the way a pen makes it: two quick flicks, not a filled triangle
  const [px, py] = pts[pts.length - 1]
  const [qx, qy] = pts[pts.length - 2]
  const a = Math.atan2(py - qy, px - qx)
  const len = 11
  const wing = (s) => [px + len * Math.cos(a + Math.PI + s * 0.48), py + len * Math.sin(a + Math.PI + s * 0.48)]
  const head = gen.toPaths(gen.linearPath([wing(1), [px, py], wing(-1)],
    { ...o, seed: seed + 1, roughness: 0.8, strokeWidth: 1.6 }))
  return { line, head }
}

/** Handwritten text: each glyph tilted a little, deterministically. */
function HandText({ lines, x, y, px, color, seed, anchor = 'middle', weight = 500 }) {
  const top = y - ((lines.length - 1) * LINE_H) / 2
  return (
    <text x={x} y={top} textAnchor={anchor} dominantBaseline="central"
          fontFamily={FONT} fontSize={px} fill={color} style={{ fontWeight: weight }}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : LINE_H}
               rotate={[...l].map((_, j) => ((jitter(seed + i, j) - 0.5) * 7).toFixed(1)).join(' ')}>
          {l}
        </tspan>
      ))}
    </text>
  )
}

/** A stroke traced along its path, starting at `t` and taking `d` ms. */
function Stroke({ path, t, d, animate }) {
  return (
    <path d={path.d} stroke={path.stroke} strokeWidth={path.strokeWidth}
          fill="none" strokeLinecap="round" strokeLinejoin="round" pathLength={1}
          className={animate ? 'ink-stroke' : undefined}
          style={animate ? { '--t': `${t}ms`, '--d': `${d}ms` } : undefined} />
  )
}

/** Text revealed left to right, like being written. */
function Written({ id, box, t, d, animate, children }) {
  if (!animate) return children
  return (
    <g clipPath={`url(#${id})`}>
      <clipPath id={id}>
        <rect x={box.x} y={box.y} width={box.w} height={box.h} className="ink-write"
              style={{ '--t': `${t}ms`, '--d': `${d}ms` }} />
      </clipPath>
      {children}
    </g>
  )
}

export default function HandDiagram({ diagram: d, animate = true, onNodeClick }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const wrapRef = useRef(null)
  const [fontsReady, setFontsReady] = useState(() => document.fonts?.status === 'loaded')
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState(null)
  // whether to animate is decided once: a re-render must never replay it
  const [playing] = useState(animate)

  useEffect(() => {
    if (!fontsReady) document.fonts?.ready.then(() => setFontsReady(true))
  }, [fontsReady])

  const L = useMemo(() => layout(d), [d, fontsReady])            // eslint-disable-line react-hooks/exhaustive-deps
  const { at } = useMemo(() => diagramTimeline(d), [d])
  const seed = useMemo(() => hash(d.title + d.nodes.map((n) => n.id).join('|')), [d])
  const drawn = useMemo(() => {
    const gen = rough.generator()
    return {
      nodes: L.nodes.map((n, i) => shapePaths(gen, n, seed + i * 7)),
      edges: L.edges.map((e) => edgePaths(gen, e, seed + 1000 + e.i * 11, L.arrows)),
      outline: (L.figure?.strokes || []).map((p, i) => gen.toPaths(
        gen.path(p, { seed: seed + i * 5, roughness: 1.15, bowing: 1.1,
                      stroke: INK, strokeWidth: 1.8, fill: undefined }))),
      underline: gen.toPaths(gen.curve(
        Array.from({ length: 6 }, (_, i) => [
          16 + (i / 5) * Math.min(L.width - 40, textWidth(d.title, 22) + 40),
          CAPTION_H - 8 + Math.sin(i * 1.7 + seed) * 2.2]),
        { seed, roughness: 0.9, stroke: INK, strokeWidth: 1.2 })),
    }
  }, [L, seed, d.title])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const scale = width ? Math.min(1, width / L.width) : 1
  // the block occupies whole ruled lines so text after it stays on the lines
  const boxH = snapToRules(L.height * scale)
  const capW = textWidth(`Fig. ${d.title}`, 22) + 30

  return (
    <div ref={wrapRef} className="ink-diagram my-0 w-full" style={{ height: boxH }}>
      <svg width={L.width * scale} height={L.height * scale}
           viewBox={`0 0 ${L.width} ${L.height}`} className="mx-auto block overflow-visible"
           role="img" aria-label={`Diagram: ${d.title}`}>
        {/* caption, written first, with a wavy underline */}
        <Written id={`${uid}c`} box={{ x: 0, y: 0, w: capW + 20, h: CAPTION_H }}
                 t={at.caption.t} d={at.caption.d} animate={playing}>
          <HandText lines={[`Fig. ${d.title}`]} x={16} y={CAPTION_H / 2 - 4} px={22}
                    color={INK} seed={seed} anchor="start" weight={600} />
        </Written>
        {drawn.underline.map((p, i) => (
          <Stroke key={`u${i}`} path={p} t={at.underline.t} d={at.underline.d} animate={playing} />
        ))}
        {/* the hint only when it will not run into the caption */}
        {onNodeClick && L.width - capW > textWidth('tap a block to ask about it', 15) + 40 && (
          <g opacity={0.75}>
            <HandText lines={['tap a block to ask about it']} x={L.width - 12}
                      y={CAPTION_H / 2 - 4} px={15} color={PENCIL} seed={seed + 3}
                      anchor="end" weight={400} />
          </g>
        )}

        {/* the figure itself: our geometry, traced as if drawn by hand */}
        {L.figure && (
          <g transform={`translate(${L.figX} ${L.figY + CAPTION_H})`}>
            {drawn.outline.map((paths, i) => paths.map((p, j) => (
              <Stroke key={`o${i}-${j}`} path={p} t={at.outline[i].t}
                      d={at.outline[i].d} animate={playing} />
            )))}
          </g>
        )}

        {/* connectors and their pencil notes */}
        {L.edges.map((e, k) => {
          const t = at.edges[e.i]
          const { line, head } = drawn.edges[k]
          return (
            <g key={`e${e.i}`}>
              {line.map((p, i) => <Stroke key={i} path={p} t={t.line.t} d={t.line.d} animate={playing} />)}
              {head.map((p, i) => <Stroke key={`h${i}`} path={p} t={t.head.t} d={t.head.d} animate={playing} />)}
              {e.label && e.x != null && (
                <Written id={`${uid}e${e.i}`}
                         box={{ x: e.x - e.width / 2 - 4, y: e.y + CAPTION_H - 14, w: e.width + 8, h: 28 }}
                         t={t.label.t} d={t.label.d} animate={playing}>
                  <g transform={`rotate(${((jitter(seed, e.i) - 0.5) * 6).toFixed(1)} ${e.x} ${e.y + CAPTION_H})`}>
                    {!e.note && (
                      <rect x={e.x - e.width / 2} y={e.y + CAPTION_H - 10} width={e.width}
                            height={20} rx={6} fill="#fbf9f3" opacity={0.92} />
                    )}
                    <HandText lines={[e.label]} x={e.x} y={e.y + CAPTION_H} px={EDGE_PX}
                              color={PENCIL} seed={seed + 50 + e.i} weight={400} />
                  </g>
                </Written>
              )}
            </g>
          )
        })}

        {/* blocks, each a sketched outline with its name written in */}
        {L.nodes.map((n, k) => {
          const t = at.nodes[n.id]
          const cy = n.y + CAPTION_H
          const box = { x: n.x - n.width / 2, y: cy - n.height / 2, w: n.width, h: n.height }
          return (
            <g key={n.id} data-block={n.label}
               onClick={onNodeClick ? () => onNodeClick(n.label) : undefined}
               onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
               style={{ cursor: onNodeClick ? 'pointer' : 'default' }}>
              <title>{onNodeClick ? `Ask about "${n.label}"` : n.label}</title>
              {/* a highlighter swipe under the block on hover */}
              <rect x={box.x - 4} y={box.y - 4} width={box.w + 8} height={box.h + 8} rx={8}
                    fill={hover === n.id && onNodeClick ? '#fde68a' : 'transparent'}
                    opacity={0.45} />
              {drawn.nodes[k].map((p, i) => (
                <Stroke key={i} path={p} t={t.box.t} d={t.box.d} animate={playing} />
              ))}
              <Written id={`${uid}n${k}`} box={box} t={t.label.t} d={t.label.d} animate={playing}>
                <HandText lines={n.lines} x={n.x} y={cy} px={LABEL_PX} color={INK}
                          seed={seed + k * 13} />
              </Written>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
