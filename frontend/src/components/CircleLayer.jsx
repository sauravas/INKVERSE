import { useEffect, useRef, useState } from 'react'
import { isLoop } from '../lib/circle'

/**
 * A pencil layer over an answer. While active, a loop drawn around anything
 * (blocks, formulas, words) is reported as a polygon in client coordinates;
 * the loop stays on the page as a red-pencil annotation. Inactive, it lets
 * every click through to the answer underneath.
 */
export default function CircleLayer({ active, onCircle, resetKey }) {
  const ref = useRef(null)
  const [loops, setLoops] = useState([])
  const [live, setLive] = useState(null)
  const pts = useRef([])

  useEffect(() => { setLoops([]) }, [resetKey])

  const local = (e) => {
    const r = ref.current.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const down = (e) => {
    if (!active) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pts.current = [local(e)]
    setLive(pts.current)
  }
  const move = (e) => {
    if (!active || !pts.current.length) return
    const evs = e.nativeEvent.getCoalescedEvents?.()
    for (const ev of (evs && evs.length ? evs : [e.nativeEvent])) pts.current.push(local(ev))
    setLive([...pts.current])
  }
  const up = () => {
    const p = pts.current
    pts.current = []
    setLive(null)
    if (!isLoop(p)) return
    setLoops((l) => [...l, p])
    const r = ref.current.getBoundingClientRect()
    onCircle?.(p.map(([x, y]) => [x + r.left, y + r.top]))
  }
  const path = (p) => `M${p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}`

  return (
    <svg ref={ref}
         className={`absolute inset-0 z-10 h-full w-full ${active ? 'ink-surface' : 'pointer-events-none'}`}
         style={active ? { cursor: 'crosshair' } : undefined}
         onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {[...loops, ...(live ? [live] : [])].map((p, i) => (
        <path key={i} d={path(p)} fill="none" stroke="#c2410c" strokeWidth={2.2}
              strokeLinecap="round" strokeLinejoin="round" opacity={0.8} />
      ))}
    </svg>
  )
}

/** Circle mode: draw a loop around part of the answer to ask about it. */
export function CircleToggle({ on, onChange, missed }) {
  return (
    <span className="ml-auto inline-flex items-center gap-2">
      {missed && (
        <span className="text-[11px] text-orange-800">
          nothing inside that loop - circle a block, a formula or some words
        </span>
      )}
      <button type="button" onClick={() => onChange(!on)}
              title="Draw a loop around a block, formula or words to ask about it"
              className={`rounded-full px-2.5 leading-6 text-xs ring-1 ${on
                ? 'bg-orange-600 text-white ring-orange-600'
                : 'bg-white text-orange-800 ring-orange-300 hover:bg-orange-50'}`}>
        {on ? 'circling - draw a loop' : '◯ Circle to ask'}
      </button>
    </span>
  )
}
