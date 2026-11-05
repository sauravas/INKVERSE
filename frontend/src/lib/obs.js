// Live agent observability feed.
//
// Subscribes to GET /api/obs/stream (server-sent events). The server replays
// its recent buffer on connect, so the view is complete even after a reload.
// Everything shown in the agent graph and log is derived from these events;
// nothing here can affect the notebook.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'

export const AGENT_COLORS = {
  orchestrator: '#16213a',
  reader: '#2f6fed',
  verifier: '#7c3aed',
  tutor: '#0f766e',
  explainer: '#c2410c',
  mentor: '#a16207',
  examiner: '#8a94a8',
  librarian: '#0369a1',
  researcher: '#b91c1c',
  hinter: '#4d7c0f',
  notewriter: '#7e22ce',
  planner: '#be185d',
}

export const AGENT_SHORT = {
  orchestrator: 'Orchestrator',
  reader: 'Reader',
  verifier: 'Verifier',
  tutor: 'Tutor',
  explainer: 'Explainer',
  mentor: 'Mentor',
  examiner: 'Examiner',
  librarian: 'Librarian',
  researcher: 'Research',
  hinter: 'Hint',
  notewriter: 'Notes',
  planner: 'Planner',
}

const MAX_EVENTS = 400
const FLASH_MS = 1800

export function useAgentFeed(provider) {
  const [events, setEvents] = useState([])
  const [status, setStatus] = useState('connecting')
  const [topo, setTopo] = useState(null)
  const [seedResident, setSeedResident] = useState([])
  const [now, setNow] = useState(() => Date.now())
  const lastSeq = useRef(0)
  const openedAt = useRef(0)
  const statsTimer = useRef(null)

  const refreshTopo = useMemo(() => () => {
    clearTimeout(statsTimer.current)
    statsTimer.current = setTimeout(() => {
      fetch(`/api/obs/agents${provider ? `?provider=${provider}` : ''}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((t) => t && setTopo(t))
        .catch(() => {})
    }, 250)
  }, [provider])

  // the stream must not reconnect when the provider changes, so it calls the
  // latest refresher through a ref
  const refreshRef = useRef(refreshTopo)
  useEffect(() => { refreshRef.current = refreshTopo; refreshTopo() }, [refreshTopo])

  useEffect(() => {
    api.memory().then((m) => setSeedResident(m.loaded || [])).catch(() => {})
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/obs/stream')
    es.onopen = () => {
      // a (re)connect replays the server buffer; start clean so a restarted
      // server, whose sequence numbers begin again at 1, is not filtered out
      lastSeq.current = 0
      openedAt.current = Date.now()
      setEvents([])
      setStatus('live')
    }
    es.onerror = () => setStatus('offline')   // EventSource retries by itself
    es.onmessage = (m) => {
      let ev
      try { ev = JSON.parse(m.data) } catch { return }
      if (!ev || ev.seq <= lastSeq.current) return
      lastSeq.current = ev.seq
      // the replayed backlog arrives right after connecting; only events that
      // happen while the page is open are animated as moving data
      ev.live = Date.now() - openedAt.current > 1200
      setEvents((prev) => {
        const next = prev.length >= MAX_EVENTS ? prev.slice(-MAX_EVENTS + 1) : prev.slice()
        next.push(ev)
        return next
      })
      if (ev.kind === 'agent.end') refreshRef.current()
    }
    return () => es.close()
  }, [])

  // derive live state from the event list
  const derived = useMemo(() => {
    const running = {}          // agent -> {count, message, since}
    const runs = {}             // trace -> run.start event
    const lastEnd = {}          // agent -> agent.end event
    const liveEdges = {}        // "from>to" -> ts
    const resident = new Set(seedResident)
    const lastOutput = {}       // agent -> last agent.output event
    let lastRun = null          // trace of the newest run
    for (const ev of events) {
      const a = ev.agent
      if (ev.kind === 'agent.output') lastOutput[a] = ev
      if (ev.kind === 'agent.start') {
        const r = running[a] || { count: 0 }
        running[a] = { count: r.count + 1, message: ev.message, since: ev.ts }
        liveEdges[`${ev.data?.caller || 'orchestrator'}>${a}`] = ev.ts
      } else if (ev.kind === 'agent.end') {
        if (running[a]) {
          running[a].count -= 1
          if (running[a].count <= 0) delete running[a]
        }
        lastEnd[a] = ev
      } else if (ev.kind === 'run.start') {
        runs[ev.trace] = ev
        lastRun = ev.trace
      } else if (ev.kind === 'run.end') {
        delete runs[ev.trace]
      } else if (ev.kind === 'model.call' && ev.data?.model) {
        resident.add(ev.data.model)
      } else if (ev.kind === 'model.evict') {
        if (ev.data?.model) resident.delete(ev.data.model)
        for (const m of ev.data?.models || []) resident.delete(m)
      }
    }
    // an edge stays lit while its target runs, then fades out
    const edges = {}
    for (const [key, ts] of Object.entries(liveEdges)) {
      const to = key.split('>')[1]
      const ended = lastEnd[to]
      const done = ended && ended.ts >= ts
      if (done) {
        if (now - ended.ts * 1000 < FLASH_MS) edges[key] = 'fading'
        continue
      }
      // An agent.start whose agent.end never arrived - the server restarted
      // mid-run, or the end scrolled out of the event buffer - used to leave
      // this edge "live" for the rest of the session. The CSS for a live edge
      // animates stroke-dashoffset forever, so the browser kept repainting
      // the whole rails SVG on an idle page. Trust the running set instead,
      // and let an orphan expire.
      if (running[to]) edges[key] = 'live'
      else if (now - ts * 1000 < FLASH_MS) edges[key] = 'fading'
    }
    const flash = {}
    for (const [a, ev] of Object.entries(lastEnd)) {
      const age = now - ev.ts * 1000
      const status = ev.data?.status
      if (status === 'error' && age < FLASH_MS * 2.5) flash[a] = 'error'
      else if (status !== 'error' && age < FLASH_MS) flash[a] = status === 'cancelled' ? 'cancelled' : 'ok'
    }
    return {
      running, flash, edges, resident, lastOutput, lastRun,
      activeRuns: Object.values(runs),
    }
  }, [events, now, seedResident])

  // tick only while something is animating, so an idle notebook does no work
  const animating = Object.keys(derived.running).length > 0
    || Object.keys(derived.flash).length > 0 || Object.keys(derived.edges).length > 0
  useEffect(() => {
    if (!animating) return undefined
    const t = setInterval(() => setNow(Date.now()), 400)
    return () => clearInterval(t)
  }, [animating])

  return { events, status, topo, now, ...derived }
}

// What the student can do once a flow has finished.
const NEXT_FLOW = {
  read: { flow: 'solve', agent: 'tutor',
          text: 'Solve: confirm the question to send it to the Tutor' },
  solve: { flow: 'explain', agent: 'explainer',
           text: 'Ask about a step: select a step to call the Explainer' },
  explain: { flow: 'explain', agent: 'explainer',
             text: 'Ask about another step, or save the question to the dashboard' },
  dashboard: { flow: 'read', agent: 'reader',
               text: 'Read a page: write a question and press Solve' },
}

/**
 * Who is working right now and what happens next, for one rebuilt run.
 * Returns {now: {agent, label, t0}|null, next: {agent, label}|null, waiting}.
 */
export function nowNext(run) {
  if (!run) {
    return { now: null, waiting: 'Waiting for a question',
             next: { agent: 'reader', label: NEXT_FLOW.dashboard.text } }
  }
  const i = run.steps.findIndex((s) => s.state === 'running')
  if (run.status === 'running') {
    const cur = i >= 0 ? run.steps[i] : null
    const from = i >= 0 ? i + 1 : run.steps.findIndex((s) => s.state === 'pending')
    const nxt = from >= 0 ? run.steps.slice(from).find((s) => s.state === 'pending') : null
    return {
      now: cur ? { agent: cur.agent, label: cur.label, t0: cur.t0 }
        : { agent: 'orchestrator', label: 'Routing the request' },
      next: nxt ? { agent: nxt.agent, label: nxt.label }
        : { agent: 'orchestrator', label: 'Finish the run' },
    }
  }
  if (run.status === 'error') {
    const bad = run.steps.find((s) => s.state === 'error')
    return { now: null, waiting: `Failed at: ${bad ? bad.label : run.flow.name}`,
             failed: true,
             next: { agent: run.steps.find((s) => s.agent !== 'orchestrator')?.agent
                     || 'orchestrator', label: `Retry: ${run.flow.name}` } }
  }
  const n = NEXT_FLOW[run.flow.id]
  return {
    now: null,
    waiting: run.flow.id === 'read' ? 'Waiting for you to confirm the question'
      : `${run.flow.name} finished`,
    next: n ? { agent: n.agent, label: n.text } : null,
  }
}

/**
 * Rebuild one run's orchestration flow from its events.
 *
 * A flow step id is either an agent id (driven by that agent's span) or an
 * orchestrator step (driven by "step" events). Steps the run never reached are
 * marked skipped once the run has ended.
 */
export function runFlow(events, trace, flows) {
  if (!trace || !flows) return null
  const evs = events.filter((e) => e.trace === trace)
  const start = evs.find((e) => e.kind === 'run.start')
  if (!start) return null
  const flow = flows.find((f) => f.id === start.data?.flow)
  if (!flow) return null
  const end = evs.find((e) => e.kind === 'run.end')

  const st = Object.fromEntries(flow.steps.map((s) => [s.id, { state: 'pending' }]))
  for (const e of evs) {
    const sid = e.kind === 'step' ? e.data?.step
      : e.kind.startsWith('agent.') ? e.agent : null
    const s = sid && st[sid]
    if (!s) continue
    if (e.kind === 'step') {
      s.state = e.data?.skipped ? 'skipped' : e.level === 'error' ? 'error' : 'done'
      s.note = e.message
      s.level = e.level
    } else if (e.kind === 'agent.start') {
      s.state = 'running'
      s.note = e.message
      s.t0 = e.ts
      if (e.data?.caller && e.data.caller !== 'orchestrator') s.handoff = e.data.caller
    } else if (e.kind === 'agent.output') {
      s.note = e.message
      s.level = e.level
    } else if (e.kind === 'agent.error') {
      s.state = 'error'
      s.note = e.message
    } else if (e.kind === 'agent.end') {
      const status = e.data?.status
      s.state = status === 'ok' ? 'done' : status === 'error' ? 'error' : 'cancelled'
      s.ms = e.data?.duration_ms
    }
  }
  const status = end ? end.data?.status : 'running'
  if (end) {
    for (const s of Object.values(st)) {
      if (s.state === 'pending') {
        s.state = 'skipped'
        s.note = status === 'ok' ? 'not needed for this request' : 'not reached'
      }
    }
  }
  return {
    trace, flow, status,
    message: start.message,
    startTs: start.ts,
    ms: end?.data?.duration_ms,
    steps: flow.steps.map((s) => ({ ...s, ...st[s.id] })),
  }
}

export function fmtTime(ts) {
  const d = new Date(ts * 1000)
  return d.toTimeString().slice(0, 8)
}

export function fmtMs(ms) {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
