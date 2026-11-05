import { useEffect, useRef, useState } from 'react'

/**
 * The answer belongs to the page, not to the device that asked for it.
 *
 * The laptop and the phone are one workspace - the same strokes, the same
 * pages - so an answer that appeared only on whichever screen pressed Solve
 * would be the one thing in the app that was not shared. The server
 * broadcasts the same typed events it streams back to the caller, and both
 * devices fold them here.
 *
 * It stays a passive listener: the device that asked renders from its own
 * HTTP stream, which is lower latency, and ignores the echo. The other one
 * follows along.
 */
export function useSharedAnswer(sync, { ignore = false } = {}) {
  const [state, setState] = useState(null)   // {question, steps, streaming}
  const steps = useRef([])
  const live = useRef(false)

  useEffect(() => {
    if (!sync?.on) return undefined
    return sync.on((m) => {
      if (m.t === 'asking') {
        steps.current = []
        live.current = true
        setState({ question: m.question, steps: [], streaming: true })
        return
      }
      if (m.t !== 'answer' || !live.current) return
      const ev = m.event
      if (!ev) return
      if (ev.type === 'start') {
        steps.current = []
        setState((s) => ({ ...(s || {}), steps: [], streaming: true }))
      } else if (ev.type === 'step_open') {
        steps.current = [...steps.current,
                         { index: ev.index, title: ev.title, final: ev.final,
                           segments: [] }]
        setState((s) => ({ ...(s || {}), steps: steps.current, streaming: true }))
      } else if (ev.type === 'segment' && steps.current.length) {
        // only the step being written changes, so finished ones keep their
        // identity and are not re-rendered for every token
        const last = steps.current.length - 1
        const cur = steps.current[last]
        steps.current = [...steps.current.slice(0, last), {
          ...cur,
          segments: [...cur.segments, {
            kind: ev.kind, value: ev.value, display: ev.display,
            ...(ev.diagram ? { diagram: ev.diagram } : {}),
            ...(ev.table ? { table: ev.table } : {}),
            ...(ev.code ? { code: ev.code } : {}),
          }],
        }]
        setState((s) => ({ ...(s || {}), steps: steps.current, streaming: true }))
      } else if (ev.type === 'done') {
        live.current = false
        setState((s) => (s ? { ...s, steps: steps.current, streaming: false } : s))
      } else if (ev.type === 'error') {
        live.current = false
        setState((s) => (s ? { ...s, streaming: false, error: ev.message } : s))
      }
    })
  }, [sync])

  return ignore ? null : state
}
