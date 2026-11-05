// Agent observability beside the notebook page.
//
// Right of the page (the demo view): a LangGraph-style workflow chart where a
// dot travels along the edges as the real event stream shows agents being
// called and returning, with NOW / NEXT on top and the live log underneath.
// Left of the page: the step-by-step flow tracker and per-agent activity.
// Whatever does not fit beside the page opens from a button, so the page
// itself is never covered.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AGENT_COLORS, AGENT_SHORT, fmtMs, fmtTime, nowNext, runFlow, useAgentFeed,
} from '../lib/obs'

const MIN_RAIL = 240
const MAX_RAIL = 420
const GAP = 16
const SCROLLBAR = 8

// Free desk space either side of the actual page element.
function measure(host) {
  const hr = host.getBoundingClientRect()
  const paper = host.querySelector('[data-paper]') || host.querySelector('.ruled')
  if (paper) {
    const pr = paper.getBoundingClientRect()
    return { w: hr.width, left: pr.left - hr.left, right: hr.right - pr.right - SCROLLBAR }
  }
  const side = (hr.width - Math.min(hr.width * 0.94, 880)) / 2
  return { w: hr.width, left: side, right: side - SCROLLBAR }
}

export default function AgentRails({ hostRef, provider }) {
  const feed = useAgentFeed(provider)
  const [box, setBox] = useState({ w: 0, left: 0, right: 0 })
  const [selected, setSelected] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [pinned, setPinned] = useState(null)     // trace shown in flow details

  useEffect(() => {
    const el = hostRef.current
    if (!el) return undefined
    const update = () => setBox(measure(el))
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const paper = el.querySelector('[data-paper]') || el.querySelector('.ruled')
    if (paper) ro.observe(paper)
    const raf = requestAnimationFrame(update)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [hostRef])

  const leftW = Math.min(box.left - GAP * 2, MAX_RAIL)
  const rightW = Math.min(box.right - GAP * 2, MAX_RAIL)
  const showLeft = leftW >= MIN_RAIL
  const showRight = rightW >= MIN_RAIL
  const toggle = (id) => setSelected((s) => (s === id ? null : id))

  if (!box.w) return null

  const workflow = <WorkflowCard feed={feed} selected={selected} onSelect={toggle} />
  const log = (
    <LogCard feed={feed} selected={selected} onPinRun={setPinned}
             onClearFilter={() => setSelected(null)} />
  )
  const details = (
    <DetailsCard feed={feed} selected={selected} onSelect={toggle}
                 pinned={pinned} onUnpin={() => setPinned(null)} />
  )
  const running = Object.keys(feed.running).length

  return (
    <>
      {showRight && (
        <aside className="pointer-events-auto absolute bottom-4 top-4 z-10 flex flex-col gap-3"
               style={{ right: GAP + SCROLLBAR, width: rightW }}>
          <div className="shrink-0">{workflow}</div>
          <div className="flex min-h-[140px] flex-1 flex-col">{log}</div>
        </aside>
      )}
      {showLeft && (
        <aside className="pointer-events-auto absolute bottom-4 top-4 z-10 flex flex-col"
               style={{ left: GAP, width: leftW }}>
          {details}
        </aside>
      )}

      {(!showLeft || !showRight) && (
        <button onClick={() => setDrawer(true)}
                className="absolute bottom-4 left-4 z-20 inline-flex items-center gap-2
                           rounded-full bg-paper px-3 py-1.5 text-xs shadow-md ring-1
                           ring-black/10 hover:bg-white">
          <span className={`inline-block h-2 w-2 rounded-full ${
            running ? 'agent-dot-live bg-accent' : 'bg-ink-soft/40'}`} />
          {showRight ? 'Flow details' : 'Agent workflow'}
          {running ? ` · ${running} running` : ''}
        </button>
      )}
      {drawer && (!showLeft || !showRight) && (
        <div className="absolute inset-0 z-30 flex justify-end bg-black/15"
             onClick={() => setDrawer(false)}>
          <div className="scroll-thin flex h-full w-[min(420px,100%)] flex-col gap-3
                          overflow-y-auto bg-[#eceadf] p-3 shadow-xl"
               onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setDrawer(false)}
                    className="self-end text-xs text-ink-soft hover:underline">close</button>
            {!showRight && <div className="shrink-0">{workflow}</div>}
            {!showLeft && <div className="shrink-0">{details}</div>}
            {!showRight && <div className="flex h-[60vh] shrink-0 flex-col">{log}</div>}
          </div>
        </div>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- shell */

function Card({ title, right, children, className = '' }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-lg bg-paper/95 shadow-[0_2px_14px_rgba(28,25,18,0.10)]
                         ring-1 ring-paper-edge ${className}`}>
      <header className="flex items-center gap-2 border-b border-black/5 px-3 py-2">
        <span className="hand text-[1.45rem] leading-none">{title}</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-soft">{right}</span>
      </header>
      {children}
    </section>
  )
}

function LiveDot({ status }) {
  const color = status === 'live' ? '#0ca30c' : status === 'offline' ? '#d03b3b' : '#fab219'
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {status}
    </span>
  )
}

function AgentTag({ id }) {
  const c = AGENT_COLORS[id] || '#46557a'
  return (
    <span className="inline-block shrink-0 rounded px-1 font-sans text-[10px] font-semibold"
          style={{ color: c, background: `${c}14` }}>
      {AGENT_SHORT[id] || id}
    </span>
  )
}

/* ------------------------------------------------- LangGraph-style chart */

// Supervisor pattern: the orchestrator routes to an agent (dashed =
// conditional route) and the agent returns to it; the Reader hands numeric
// readings to the Verifier; the Explainer asks the Reader to read a
// handwritten follow-up.
const VB = { w: 240, h: 318 }
const NODE = { w: 100, h: 46 }
const POS = {
  start: { x: 120, y: 13, w: 78, h: 20 },
  orchestrator: { x: 120, y: 62 },
  reader: { x: 62, y: 140 },
  tutor: { x: 178, y: 140 },
  verifier: { x: 62, y: 216 },
  explainer: { x: 178, y: 216 },
  mentor: { x: 178, y: 292 },
  end: { x: 62, y: 296, w: 78, h: 20 },
}
const AGENTS_ON_CHART = ['reader', 'tutor', 'verifier', 'explainer', 'mentor']
const LANE = 'M 210 62 L 226 62 Q 234 62 234 70'

const EDGES = {
  'start>orchestrator': { d: 'M 120 23 L 120 42', kind: 'solid',
                          title: 'Every request enters the orchestrator' },
  'orchestrator>reader': { d: 'M 82 82 C 82 100, 62 98, 62 117', kind: 'route',
                           title: 'Read a page' },
  'orchestrator>tutor': { d: 'M 158 82 C 158 100, 178 98, 178 117', kind: 'route',
                          title: 'Solve the confirmed question' },
  'orchestrator>explainer': { d: `${LANE} L 234 208 Q 234 216 228 216`, kind: 'route',
                              title: 'Explain one step' },
  'orchestrator>mentor': { d: `${LANE} L 234 284 Q 234 292 228 292`, kind: 'route',
                           title: 'Readiness for the dashboard' },
  'reader>verifier': { d: 'M 62 163 L 62 193', kind: 'solid',
                       title: 'Digits found: hand the reading to the Verifier' },
  'explainer>reader': { d: 'M 128 208 C 118 206, 122 152, 112 148', kind: 'solid',
                        title: 'Handwritten follow-up: ask the Reader to read it' },
  'orchestrator>end': { d: 'M 30 62 L 13 62 Q 5 62 5 70 L 5 288 Q 5 296 13 296 L 23 296',
                        kind: 'route', title: 'Run finished' },
}

// Turn one real event into a hop of the moving dot.
function hopFor(ev, callers) {
  if (ev.kind === 'run.start') return ['start', 'orchestrator']
  if (ev.kind === 'run.end') return ['orchestrator', 'end']
  if (ev.kind === 'agent.start') return [ev.data?.caller || 'orchestrator', ev.agent]
  if (ev.kind === 'agent.end') return [ev.agent, callers[ev.agent] || 'orchestrator']
  return null
}

function edgeFor(from, to) {
  if (EDGES[`${from}>${to}`]) return { key: `${from}>${to}`, reverse: false }
  if (EDGES[`${to}>${from}`]) return { key: `${to}>${from}`, reverse: true }
  return null
}

const HOP_MS = 650

function WorkflowChart({ feed, selected, onSelect }) {
  const { events, running, flash, edges, activeRuns, topo, now } = feed
  const pathRefs = useRef({})
  const seen = useRef(new Set())
  const callers = useRef({})
  const queueEnd = useRef(0)
  const [tokens, setTokens] = useState([])

  // one moving dot per real hop, played in order so a burst of events still
  // reads as a path; the queue speeds up if it falls behind
  useEffect(() => {
    const add = []
    for (const ev of events) {
      if (seen.current.has(ev.seq)) continue
      seen.current.add(ev.seq)
      if (ev.kind === 'agent.start') callers.current[ev.agent] = ev.data?.caller || 'orchestrator'
      if (!ev.live) continue
      const hop = hopFor(ev, callers.current)
      const edge = hop && edgeFor(hop[0], hop[1])
      if (!edge) continue
      const t = performance.now()
      const delay = Math.max(0, queueEnd.current - t)
      const dur = delay > 1500 ? 260 : HOP_MS
      queueEnd.current = t + delay + dur
      add.push({ id: ev.seq, ...edge, delay, dur,
                 color: AGENT_COLORS[hop[1]] || AGENT_COLORS[hop[0]] || '#16213a' })
    }
    if (seen.current.size > 3000) seen.current = new Set([...seen.current].slice(-500))
    if (add.length) setTokens((prev) => [...prev, ...add])
  }, [events])

  const done = useCallback((id) => setTokens((prev) => prev.filter((t) => t.id !== id)), [])
  const stats = topo.stats || {}
  const res = Object.fromEntries(topo.resources.map((r) => [r.id, r]))
  const upcoming = nowNext(runFlow(events, feed.lastRun, topo.flows)).next?.agent
  const orchLive = activeRuns.length > 0

  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className="block w-full select-none"
         role="img" aria-label="Live agent workflow">
      <defs>
        <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6"
                markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" fill="#7d879c" />
        </marker>
        <filter id="wf-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* edges */}
      {Object.entries(EDGES).map(([key, e]) => {
        const to = key.split('>')[1]
        const live = edges[key] === 'live'
        const color = live ? (AGENT_COLORS[to] || '#16213a') : '#a3abbd'
        return (
          <path key={key} ref={(el) => { pathRefs.current[key] = el }} d={e.d} fill="none"
                stroke={color} strokeWidth={live ? 2.2 : 1.3}
                strokeDasharray={!live && e.kind === 'route' ? '4 3' : undefined}
                className={live ? 'edge-live' : ''} markerEnd="url(#wf-arrow)">
            <title>{e.title}</title>
          </path>
        )
      })}

      {/* __start__ / __end__ */}
      {['start', 'end'].map((id) => {
        const p = POS[id]
        return (
          <g key={id}>
            <rect x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={p.h / 2}
                  fill="#ece7da" stroke="#cfc8b8" />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="10.5"
                  fontFamily="ui-monospace, Consolas, monospace" fill="#46557a">
              {`__${id}__`}
            </text>
          </g>
        )
      })}

      {/* orchestrator */}
      <g onClick={() => onSelect('orchestrator')} className="cursor-pointer">
        <title>Orchestrator: deterministic code that routes each request, enforces consent and schedules models</title>
        <rect x={30} y={42} width={180} height={40} rx={9}
              fill={orchLive ? '#16213a' : '#26324f'}
              stroke={selected === 'orchestrator' ? '#fab219' : orchLive ? '#2f6fed' : 'none'}
              strokeWidth="2" className={orchLive ? 'node-live' : ''} />
        <text x={120} y={59} textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">
          Orchestrator
        </text>
        <text x={120} y={74} textAnchor="middle" fontSize="9.5" fill="#c9d3ea">
          {orchLive ? `routing ${activeRuns.length} request${activeRuns.length > 1 ? 's' : ''}`
            : 'code router · consent · scheduler'}
        </text>
      </g>

      {/* agents */}
      {AGENTS_ON_CHART.map((id) => {
        const p = POS[id]
        const live = !!running[id]
        const f = flash[id]
        const isNext = !live && !f && upcoming === id
        const color = AGENT_COLORS[id]
        const s = stats[id]
        const elapsed = live ? Math.max(0, Math.round(now - running[id].since * 1000)) : null
        const stroke = live ? color : f === 'error' ? '#d03b3b' : f === 'ok' ? '#0ca30c'
          : selected === id ? '#fab219' : isNext ? color : '#cfc8b8'
        const model = id === 'mentor' ? 'rules, no model'
          : (id === 'reader' || id === 'verifier') ? res.vision?.detail : res.text?.detail
        return (
          <g key={id} onClick={() => onSelect(id)} className="cursor-pointer">
            <title>{`${AGENT_SHORT[id]} · ${model || ''}`}</title>
            <rect x={p.x - NODE.w / 2} y={p.y - NODE.h / 2} width={NODE.w} height={NODE.h} rx={8}
                  fill={live ? `${color}22` : '#fff'} stroke={stroke}
                  strokeWidth={live || f || selected === id ? 2.2 : isNext ? 1.6 : 1}
                  strokeDasharray={isNext ? '4 3' : undefined}
                  className={live ? 'node-live' : ''} />
            <circle cx={p.x - NODE.w / 2 + 11} cy={p.y - 7} r={4} fill={color} />
            <text x={p.x + 6} y={p.y - 2.5} textAnchor="middle" fontSize="12.5" fontWeight="700"
                  fill="#16213a">{AGENT_SHORT[id]}</text>
            <text x={p.x} y={p.y + 14} textAnchor="middle" fontSize="10"
                  fill={live || isNext ? color : f === 'error' ? '#d03b3b' : '#46557a'}
                  fontWeight={live || isNext ? 700 : 400}>
              {live ? `running ${fmtMs(elapsed)}`
                : f === 'error' ? 'failed'
                  : isNext ? 'next'
                    : s ? `${s.calls}× · ${fmtMs(s.last_ms)}` : 'idle'}
            </text>
          </g>
        )
      })}

      {/* the moving data */}
      {tokens.map((t) => (
        <Token key={t.id} token={t} path={pathRefs.current[t.key]} onDone={done} />
      ))}
    </svg>
  )
}

function Token({ token, path, onDone }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!path || !ref.current) { onDone(token.id); return undefined }
    const len = path.getTotalLength()
    const start = performance.now() + token.delay
    let raf
    const step = (t) => {
      const el = ref.current
      if (!el) return
      const k = Math.min(1, Math.max(0, (t - start) / token.dur))
      const eased = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2
      const pt = path.getPointAtLength((token.reverse ? 1 - eased : eased) * len)
      el.setAttribute('cx', pt.x)
      el.setAttribute('cy', pt.y)
      el.setAttribute('opacity', t < start ? '0' : k > 0.9 ? String((1 - k) / 0.1) : '1')
      if (k < 1) raf = requestAnimationFrame(step)
      else onDone(token.id)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [path, token, onDone])
  return (
    <circle ref={ref} r="6.5" fill={token.color} stroke="#fff" strokeWidth="1.8"
            opacity="0" filter="url(#wf-glow)" />
  )
}

function WorkflowCard({ feed, selected, onSelect }) {
  const t = feed.topo
  const run = runFlow(feed.events, feed.lastRun, t?.flows)
  return (
    <Card title="Agent workflow"
          right={(
            <>
              {t && <span>{t.counts.active} agents</span>}
              <LiveDot status={feed.status} />
            </>
          )}>
      <div className="px-3 pb-2.5 pt-2">
        <NowNext nn={nowNext(run)} now={feed.now} />
        {t ? (
          <>
            <WorkflowChart feed={feed} selected={selected} onSelect={onSelect} />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-soft">
              <span className="inline-flex items-center gap-1">
                <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#a3abbd"
                  strokeWidth="1.3" strokeDasharray="4 3" /></svg>
                conditional route
              </span>
              <span className="inline-flex items-center gap-1">
                <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#a3abbd"
                  strokeWidth="1.3" /></svg>
                hand-off
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-accent ring-2 ring-white" />
                data moving (live)
              </span>
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-xs text-ink-soft">
            {feed.status === 'offline' ? 'Backend unreachable.' : 'Loading agents…'}
          </p>
        )}
      </div>
    </Card>
  )
}

function NowNext({ nn, now }) {
  const label = 'w-9 shrink-0 text-[9.5px] font-bold uppercase tracking-wider text-ink-soft'
  return (
    <div className="mb-2 overflow-hidden rounded-md ring-1 ring-black/5">
      <div className={`flex items-center gap-2 px-2.5 py-1.5 ${
        nn.now ? 'bg-blue-50' : nn.failed ? 'bg-red-50' : 'bg-black/[0.03]'}`}>
        <span className={label}>Now</span>
        {nn.now ? (
          <>
            <span className="agent-dot-live inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: AGENT_COLORS[nn.now.agent] }} />
            <AgentTag id={nn.now.agent} />
            <span className="min-w-0 flex-1 text-[12px] font-medium leading-4 text-ink">
              {nn.now.label}
            </span>
            {nn.now.t0 && (
              <span className="shrink-0 text-[10px] tabular-nums text-ink-soft">
                {fmtMs(Math.max(0, Math.round(now - nn.now.t0 * 1000)))}
              </span>
            )}
          </>
        ) : (
          <span className={`text-[12px] leading-4 ${nn.failed ? 'text-red-700' : 'text-ink-soft'}`}>
            {nn.waiting}
          </span>
        )}
      </div>
      {nn.next && (
        <div className="flex items-center gap-2 border-t border-black/5 bg-white/60 px-2.5 py-1.5">
          <span className={label}>Next</span>
          <AgentTag id={nn.next.agent} />
          <span className="min-w-0 flex-1 text-[11.5px] leading-4 text-ink-soft">
            {nn.next.label}
          </span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------ left: details */

function DetailsCard({ feed, selected, onSelect, pinned, onUnpin }) {
  const t = feed.topo
  return (
    <Card title="Flow details" className="max-h-full"
          right={t && <span>{t.counts.active} active · {t.counts.planned} planned</span>}>
      <div className="scroll-thin min-h-0 overflow-y-auto px-3 pb-3 pt-2">
        {t ? (
          <>
            <FlowSteps feed={feed} pinned={pinned} onUnpin={onUnpin} />
            <AgentStats feed={feed} selected={selected} onSelect={onSelect} />
            <Scheduler feed={feed} />
            <AllFlows flows={t.flows} />
          </>
        ) : (
          <p className="py-6 text-center text-xs text-ink-soft">
            {feed.status === 'offline' ? 'Backend unreachable.' : 'Loading agents…'}
          </p>
        )}
      </div>
    </Card>
  )
}

const STEP_STYLE = {
  done: { icon: '✓', ring: '#0ca30c', fill: '#0ca30c', text: '#fff' },
  running: { icon: '', ring: '#2f6fed', fill: '#2f6fed', text: '#fff' },
  error: { icon: '✗', ring: '#d03b3b', fill: '#d03b3b', text: '#fff' },
  cancelled: { icon: '■', ring: '#b45309', fill: '#fff', text: '#b45309' },
  skipped: { icon: '–', ring: '#b4bccd', fill: '#fff', text: '#8a94a8' },
  pending: { icon: '', ring: '#b4bccd', fill: '#fff', text: '#8a94a8' },
}

function StepDot({ state }) {
  const st = STEP_STYLE[state] || STEP_STYLE.pending
  return (
    <span className={`relative z-[1] mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center
                      rounded-full text-[9px] font-bold ${state === 'running' ? 'agent-dot-live' : ''}`}
          style={{ background: st.fill, color: st.text, border: `1.5px solid ${st.ring}`,
                   borderStyle: state === 'skipped' ? 'dashed' : 'solid' }}>
      {st.icon}
    </span>
  )
}

function FlowSteps({ feed, pinned, onUnpin }) {
  const flows = feed.topo?.flows
  const trace = (pinned && feed.events.some((e) => e.trace === pinned)) ? pinned : feed.lastRun
  const run = runFlow(feed.events, trace, flows)
  if (!run) {
    return (
      <p className="pb-1 text-[11px] leading-4 text-ink-soft">
        Each step of the next request lights up here as the orchestrator routes it
        between agents.
      </p>
    )
  }
  const chip = run.status === 'running' ? ['running', 'bg-blue-100 text-blue-900']
    : run.status === 'ok' ? [`done ${fmtMs(run.ms)}`, 'bg-emerald-100 text-emerald-900']
      : run.status === 'error' ? [`failed ${fmtMs(run.ms)}`, 'bg-red-100 text-red-800']
        : [run.status, 'bg-amber-100 text-amber-900']
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-soft">
        <span className="font-semibold text-ink">{run.flow.name}</span>
        <span>#{run.trace}</span>
        {pinned === run.trace && (
          <button onClick={onUnpin} className="normal-case hover:underline">follow latest</button>
        )}
        <span className={`ml-auto rounded px-1.5 py-0.5 normal-case ${chip[1]}`}>{chip[0]}</span>
      </div>
      <ol>
        {run.steps.map((s, i) => {
          const elapsed = s.state === 'running' && s.t0
            ? Math.max(0, Math.round(feed.now - s.t0 * 1000)) : null
          const quiet = s.state === 'pending' || s.state === 'skipped'
          return (
            <li key={s.id} className="relative flex gap-2 pb-2.5 last:pb-0">
              {i < run.steps.length - 1 && (
                <span className="absolute left-[7.5px] top-4 h-[calc(100%-12px)] w-px bg-black/10" />
              )}
              <StepDot state={s.state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className={`text-[12px] leading-4 ${quiet ? 'text-ink-soft' : 'font-medium text-ink'}`}>
                    {s.label}
                  </span>
                  {s.agent !== 'orchestrator' && <AgentTag id={s.agent} />}
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-soft">
                    {s.state === 'running' ? `${fmtMs(elapsed)}…` : fmtMs(s.ms)}
                  </span>
                </div>
                {s.note && (
                  <div className={`mt-0.5 break-words text-[10.5px] leading-4 ${
                    s.state === 'error' ? 'text-red-700'
                      : s.level === 'warn' ? 'text-amber-800' : 'text-ink-soft'}`}>
                    {s.handoff ? `hand-off from ${AGENT_SHORT[s.handoff]} · ` : ''}{s.note}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function AgentStats({ feed, selected, onSelect }) {
  const { topo, running, lastOutput } = feed
  const stats = topo.stats || {}
  const active = topo.agents.filter((a) => a.status === 'active')
  const sel = topo.agents.find((a) => a.id === selected)
  return (
    <div className="mt-3 border-t border-black/5 pt-2 text-[11px]">
      <div className="mb-1 font-medium text-ink">Per-agent activity</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-ink-soft">
            <th className="py-0.5 font-medium">Agent</th>
            <th className="py-0.5 text-right font-medium">Calls</th>
            <th className="py-0.5 text-right font-medium">Errors</th>
            <th className="py-0.5 text-right font-medium">Avg</th>
            <th className="py-0.5 text-right font-medium">Last</th>
          </tr>
        </thead>
        <tbody>
          {active.map((a) => {
            const s = stats[a.id]
            const avg = s?.calls ? Math.round(s.total_ms / s.calls) : null
            return (
              <tr key={a.id} onClick={() => onSelect(a.id)}
                  className={`cursor-pointer border-t border-black/5 ${
                    selected === a.id ? 'bg-amber-50' : 'hover:bg-black/[0.03]'}`}>
                <td className="py-1">
                  <AgentTag id={a.id} />
                  {running[a.id] && (
                    <span className="agent-dot-live ml-1 inline-block h-1.5 w-1.5 rounded-full"
                          style={{ background: AGENT_COLORS[a.id] }} />
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">{s?.calls ?? 0}</td>
                <td className={`py-1 text-right tabular-nums ${s?.errors ? 'text-red-700' : ''}`}>
                  {s?.errors ?? 0}
                </td>
                <td className="py-1 text-right tabular-nums text-ink-soft">{fmtMs(avg) || '-'}</td>
                <td className="py-1 text-right tabular-nums text-ink-soft">{fmtMs(s?.last_ms) || '-'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {sel && (
        <div className="mt-2 rounded-md bg-amber-50/70 px-2.5 py-2 leading-4">
          <div className="font-semibold text-ink">{sel.name}</div>
          <div className="text-ink-soft">{sel.role}</div>
          <div className="mt-1 text-ink-soft">
            <b className="font-medium text-ink">Called by:</b> {sel.invoked_by}
          </div>
          {lastOutput[sel.id] && (
            <div className="mt-1 text-ink-soft">
              <b className="font-medium text-ink">Last result:</b> {lastOutput[sel.id].message}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Scheduler({ feed }) {
  const t = feed.topo
  const res = Object.fromEntries(t.resources.map((r) => [r.id, r]))
  const models = [...new Set([res.vision?.detail, res.text?.detail].filter(Boolean))]
  return (
    <div className="mt-3 rounded-md bg-black/[0.035] px-2.5 py-2 text-[11px]">
      <div className="mb-1 font-medium text-ink">Model scheduler</div>
      <div className="flex flex-wrap gap-1.5">
        {models.map((m) => {
          const on = feed.resident.has(m)
          return (
            <span key={m} title={on ? 'resident in memory' : 'not loaded'}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono
                              text-[10px] ${on ? 'bg-emerald-100 text-emerald-900'
                    : 'bg-white text-ink-soft ring-1 ring-black/10'}`}>
              {on ? '●' : '○'} {m}
            </span>
          )
        })}
      </div>
      <div className="mt-1.5 leading-4 text-ink-soft">
        {t.scheduler.exclusive_stages ? 'One stage resident at a time' : 'Stages may share memory'}
        {' · '}RAM guard {t.scheduler.ram_guard ? `keeps ${t.scheduler.min_free_gb} GB free` : 'off'}
        {' · '}provider <span className="font-mono">{t.provider}</span>
      </div>
    </div>
  )
}

function AllFlows({ flows }) {
  return (
    <details className="mt-3 text-[11px]">
      <summary className="cursor-pointer font-medium text-ink">All orchestration flows</summary>
      <ol className="mt-1.5 space-y-1.5">
        {flows.map((f) => (
          <li key={f.id} className="leading-4">
            <span className="font-semibold text-ink">{f.name}: </span>
            <span className="text-ink-soft">{f.steps.map((s) => s.label).join(' → ')}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/* ------------------------------------------------------------------ log */

function LogCard({ feed, selected, onClearFilter, onPinRun }) {
  const [paused, setPaused] = useState(null)       // frozen event list
  const [clearedAt, setClearedAt] = useState(0)
  const listRef = useRef(null)
  const stick = useRef(true)

  const source = paused || feed.events
  const shown = source.filter((e) => e.seq > clearedAt
    && (!selected || e.agent === selected
      || (selected !== 'orchestrator' && e.data?.to === selected)))

  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown.length])

  const onScroll = () => {
    const el = listRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  return (
    <Card title="Agent log" className="h-full"
          right={(
            <>
              <LiveDot status={paused ? 'paused' : feed.status} />
              <button onClick={() => setPaused(paused ? null : feed.events)}
                      className="rounded px-1.5 py-0.5 hover:bg-black/5">
                {paused ? 'resume' : 'pause'}
              </button>
              <button onClick={() => setClearedAt(feed.events.at(-1)?.seq || 0)}
                      className="rounded px-1.5 py-0.5 hover:bg-black/5">
                clear
              </button>
            </>
          )}>
      {selected && (
        <div className="flex items-center gap-2 border-b border-black/5 px-3 py-1 text-[11px]">
          <span className="text-ink-soft">Showing</span>
          <AgentTag id={selected} />
          <button onClick={onClearFilter} className="ml-auto text-ink-soft hover:underline">
            show all
          </button>
        </div>
      )}
      <div ref={listRef} onScroll={onScroll}
           className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-1.5 font-mono text-[11px]">
        {shown.length === 0 ? (
          <p className="px-1 py-6 text-center font-sans text-xs leading-5 text-ink-soft">
            No agent activity yet.<br />Write a question and press Solve.
          </p>
        ) : shown.map((e) => <LogRow key={e.seq} e={e} onPinRun={onPinRun} />)}
      </div>
    </Card>
  )
}

const KIND_ICON = {
  'agent.start': '▶', 'agent.end': '■', 'agent.output': '→', 'agent.error': '✗',
  route: '↳', 'model.call': '⚙', 'model.first_token': '⚙', 'model.evict': '⇣',
  'model.retry': '↻', 'guard.block': '⛔', 'consent.blocked': '🔒', 'run.error': '✗',
  step: '◆',
}

function LogRow({ e, onPinRun }) {
  if (e.kind === 'run.start') {
    return (
      <div onClick={() => onPinRun?.(e.trace)} title="Show this run in Flow details"
           className="mb-1 mt-2.5 cursor-pointer border-t border-dashed border-black/10 pt-1.5
                      font-sans first:mt-0 first:border-0 first:pt-0 hover:bg-black/[0.03]">
        <div className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-wide text-ink-soft">
          <span className="font-semibold text-ink">{e.data?.flow}</span>
          <span>#{e.trace}</span>
          <span className="ml-auto font-mono normal-case">{fmtTime(e.ts)}</span>
        </div>
        <div className="text-[11.5px] leading-4 text-ink">{e.message}</div>
      </div>
    )
  }
  if (e.kind === 'run.end') {
    const bad = e.data?.status === 'error'
    return (
      <div className={`py-0.5 pl-1 font-sans text-[10.5px] ${bad ? 'text-red-700' : 'text-ink-soft'}`}>
        {bad ? '✗' : '✓'} {e.message}
      </div>
    )
  }

  let tone = 'text-ink'
  if (e.level === 'error') tone = 'text-red-700'
  else if (e.level === 'warn') tone = 'text-amber-800'
  else if (e.kind.startsWith('model.') || e.kind === 'route') tone = 'text-ink-soft'

  let text = e.message
  if (e.kind === 'agent.start' && e.data?.caller && e.data.caller !== 'orchestrator') {
    text = `${text} (hand-off from ${AGENT_SHORT[e.data.caller] || e.data.caller})`
  }
  if (e.kind === 'agent.end') {
    text = e.data?.status === 'ok' ? `done in ${fmtMs(e.data.duration_ms)}`
      : `${e.data?.status} after ${fmtMs(e.data?.duration_ms)}`
  }

  return (
    <div className="flex items-start gap-1.5 rounded px-1 py-[3px] hover:bg-black/[0.03]">
      <span className="w-3 shrink-0 text-center text-ink-soft/80">{KIND_ICON[e.kind] || '·'}</span>
      <AgentTag id={e.agent} />
      <span className={`min-w-0 break-words leading-4 ${tone}`}>{text}</span>
    </div>
  )
}
