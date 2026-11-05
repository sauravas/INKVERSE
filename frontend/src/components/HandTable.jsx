import rough from 'roughjs'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RichText } from './AnswerSheet'

/**
 * A table ruled by hand on lined paper.
 *
 * Every row is a whole number of ruled lines (cells use the page's line
 * height and no vertical padding), so the paper's own rules run under each
 * row. The pen lines are drawn on top of those rules, a little wobbly, then
 * the rows are filled in one after another.
 */

const INK = '#16213a'
const T_LINE = 170
const T_CHAR = 14
const T_ROW_MIN = 260

export function tableTimeline(t) {
  const lines = t.rows.length + 2 + t.header.length + 1
  const grid = lines * T_LINE * 0.55
  let at = grid
  const rows = [t.header, ...t.rows].map((r) => {
    const d = Math.max(T_ROW_MIN, r.join(' ').length * T_CHAR)
    const slot = { t: at, d }
    at += d
    return slot
  })
  return { grid, rows, total: at }
}

function ruleShift() {
  return parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--rule-shift')) || 0
}

export default function HandTable({ table: t, animate = true }) {
  const wrap = useRef(null)
  const tbl = useRef(null)
  const [geo, setGeo] = useState(null)
  const [playing] = useState(animate)          // decided once; re-renders never replay
  const timing = useMemo(() => tableTimeline(t), [t])

  useLayoutEffect(() => {
    const measure = () => {
      const el = tbl.current
      if (!el) return
      const box = el.getBoundingClientRect()
      const rows = [...el.rows].map((r) => {
        const b = r.getBoundingClientRect()
        return { top: b.top - box.top, bottom: b.bottom - box.top }
      })
      const first = el.rows[0]
      const cols = first ? [...first.cells].map((c) => {
        const b = c.getBoundingClientRect()
        return { left: b.left - box.left, right: b.right - box.left }
      }) : []
      setGeo({ w: box.width, h: box.height, rows, cols, shift: ruleShift() })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (tbl.current) ro.observe(tbl.current)
    return () => ro.disconnect()
  }, [t])

  const strokes = useMemo(() => {
    if (!geo || !geo.rows.length) return []
    const gen = rough.generator()
    const o = (seed) => ({ seed, roughness: 0.9, bowing: 0.8, stroke: INK, strokeWidth: 1.25 })
    // a row's line is the paper rule at the bottom of its last ruled band
    const ruleY = (bottom) => bottom - 1 + geo.shift
    const top = 2
    const bottom = ruleY(geo.rows[geo.rows.length - 1].bottom)
    const left = 0
    const right = geo.w
    const out = []
    let seed = 11
    const push = (drawable, t, d) => gen.toPaths(drawable).forEach((p) => out.push({ p, t, d }))
    let at = 0
    const step = T_LINE * 0.55
    push(gen.line(left, top, right, top, o(seed++)), at, T_LINE); at += step
    // column rules, left to right
    const xs = [left, ...geo.cols.slice(0, -1).map((c) => c.right), right]
    for (const x of xs) { push(gen.line(x, top, x, bottom, o(seed++)), at, T_LINE); at += step }
    // under the header twice, as people do; then each row
    geo.rows.forEach((r, i) => {
      const y = ruleY(r.bottom)
      push(gen.line(left, y, right, y, o(seed++)), at, T_LINE)
      if (i === 0) push(gen.line(left, y + 3, right, y + 3, o(seed++)), at + 60, T_LINE)
      at += step
    })
    return out
  }, [geo])

  const rowStyle = (i) => (playing ? {
    clipPath: 'inset(0 100% 0 0)',
    animation: `ink-reveal ${timing.rows[i].d}ms linear ${timing.rows[i].t}ms forwards`,
  } : undefined)

  return (
    <div ref={wrap} className="relative my-0 max-w-full overflow-x-auto">
      <table ref={tbl} className="hand-table relative">
        <thead>
          <tr style={rowStyle(0)}>
            {t.header.map((h, j) => (
              <th key={j}><RichText text={h} className="hand" /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i} style={rowStyle(i + 1)}>
              {r.map((c, j) => <td key={j}><RichText text={c} className="hand" /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {geo && (
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible"
             width={geo.w} height={geo.h}>
          {strokes.map(({ p, t: at, d }, i) => (
            <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill="none"
                  strokeLinecap="round" pathLength={1}
                  className={playing ? 'ink-stroke' : undefined}
                  style={playing ? { '--t': `${at}ms`, '--d': `${d}ms` } : undefined} />
          ))}
        </svg>
      )}
    </div>
  )
}
