// Agent observability, drawn in the empty desk space either side of the
// notebook page: the orchestration graph on the left, the live log on the
// right. When the window is too narrow for side rails, both move into a
// drawer behind a small button so the page itself is never covered.

import { useEffect, useRef, useState } from 'react'
import {
  AGENT_COLORS, AGENT_SHORT, fmtMs, fmtTime, useAgentFeed,
} from '../lib/obs'

const PAPER_MAX = 880
const MIN_RAIL = 250
const MAX_RAIL = 400
const GAP = 16

export default function AgentRails({ hostRef, provider }) {
  const feed = useAgentFeed(provider)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [selected, setSelected] = useState(null)
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hostRef])

  const paper = Math.min(box.w * 0.94, PAPER_MAX)
  const side = (box.w - paper) / 2
  const rail = Math.min(side - GAP * 2, MAX_RAIL)
  const wide = rail >= MIN_RAIL

  const toggle = (id) => setSelected((s) => (s === id ? null : id))

  if (!box.w) return null

  if (wide) {
    return (
      <>
        <aside className="pointer-events-auto absolute bottom-4 top-4 z-10 flex flex-col"
               style={{ left: GAP, width: rail }}>
          <GraphCard feed={feed} selected={selected} onSelect={toggle} />
        </aside>
        <aside className="pointer-events-auto absolute bottom-4 top-4 z-10 flex flex-col"
               style={{ right: GAP + 6, width: rail }}>
          <LogCard feed={feed} selected={selected} onClearFilter={() => setSelected(null)} />
        </aside>
      </>
    )
  }

  const running = Object.keys(feed.running).length
  return (
    <>
      <button onClick={() => setDrawer(true)}
              className="absolute bottom-4 left-4 z-20 inline-flex items-center gap-2
                         rounded-full bg-paper px-3 py-1.5 text-xs shadow-md ring-1
                         ring-black/10 hover:bg-white">
        <span className={`inline-block h-2 w-2 rounded-full ${
          running ? 'agent-dot-live bg-accent' : 'bg-ink-soft/40'}`} />
        Agents{running ? ` · ${running} running` : ''}
      </button>
      {drawer && (
        <div className="absolute inset-0 z-30 flex justify-end bg-black/15"
             onClick={() => setDrawer(false)}>
          <div className="scroll-thin flex h-full w-[min(420px,100%)] flex-col gap-3
                          overflow-y-auto bg-[#eceadf] p-3 shadow-xl"
               onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setDrawer(false)}
                    className="self-end text-xs text-ink-soft hover:underline">close</button>
            <GraphCard feed={feed} selected={selected} onSelect={toggle} />
            <div className="h-[60vh] shrink-0">
              <LogCard feed={feed} selected={selected}
                       onClearFilter={() => setSelected(null)} />
            </div>
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

/* ---------------------------------------------------------------- graph */

function GraphCard({ feed, selected, onSelect }) {
  const t = feed.topo
  return (
    <Card title="Agents"
          right={t && (
            <span>{t.counts.active} active · {t.counts.planned} planned</span>
          )}
          className="max-h-full">
      <div className="scroll-thin min-h-0 overflow-y-auto px-3 pb-3 pt-2">
        {t ? (
          <>
            <AgentGraph feed={feed} selected={selected} onSelect={onSelect} />
            <p className="mt-1 text-[10.5px] leading-4 text-ink-soft">
              Click an agent to filter the log. Curved arrows are hand-offs:
              Reader → Verifier when digits are found, Explainer → Reader for a
              handwritten question.
            </p>
            <Scheduler feed={feed} />
            <Flows flows={t.flows} />
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

// Fixed layout in a 340-wide viewBox; the SVG scales to the rail width.
const VB_W = 340
const ROW_Y0 = 72
const ROW_H = 48
const ROW_STEP = 62
const NODE_X = 92
const NODE_W = 196
const ORCH_X = 8
const ORCH_W = 46

function AgentGraph({ feed, selected, onSelect }) {
  const { topo, running, flash, edges, activeRuns } = feed
  const agents = topo.agents
  const res = Object.fromEntries(topo.resources.map((r) => [r.id, r]))
  const stats = topo.stats || {}
  const rows = Object.fromEntries(agents.map((a, i) => [a.id, i]))
  const cy = (id) => ROW_Y0 + rows[id] * ROW_STEP + ROW_H / 2
  const orchBottom = ROW_Y0 + (agents.length - 1) * ROW_STEP + ROW_H
  const H = orchBottom + 12
  const orchLive = activeRuns.length > 0

  const edgeClass = (key) => (edges[key] === 'live' ? 'edge-live'
    : edges[key] === 'fading' ? 'edge-fading' : '')

  const modelOf = (a) => {
    if (a.status === 'planned') return 'planned · not built yet'
    if (a.kind === 'rules') return 'rules · SQLite, no model'
    return res[a.stage]?.detail || a.stage
  }

  // hand-off arcs on the right of the agent column
  const arcs = []
  if ('reader' in rows && 'verifier' in rows) {
    const a = cy('reader') + 7
    const b = cy('verifier') - 7
    arcs.push({ key: 'reader>verifier', color: AGENT_COLORS.verifier,
                d: `M ${NODE_X + NODE_W} ${a} C ${NODE_X + NODE_W + 20} ${a}, ${NODE_X + NODE_W + 20} ${b}, ${NODE_X + NODE_W + 2} ${b}`,
                title: 'Reader hands numeric readings to the Verifier' })
  }
  if ('explainer' in rows && 'reader' in rows) {
    const a = cy('explainer')
    const b = cy('reader') - 7
    arcs.push({ key: 'explainer>reader', color: AGENT_COLORS.reader,
                d: `M ${NODE_X + NODE_W} ${a} C ${NODE_X + NODE_W + 46} ${a}, ${NODE_X + NODE_W + 46} ${b}, ${NODE_X + NODE_W + 2} ${b}`,
                title: 'Explainer asks the Reader to transcribe a handwritten follow-up' })
  }

  return (
    <svg viewBox={`0 0 ${VB_W} ${H}`} className="block w-full select-none"
         role="img" aria-label="Agent orchestration graph">
      <defs>
        {['#46557a', ...Object.values(AGENT_COLORS)].map((c) => (
          <marker key={c} id={`ah-${c.slice(1)}`} viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 z" fill={c} />
          </marker>
        ))}
      </defs>

      {/* student -> orchestrator */}
      <g>
        <rect x={ORCH_X} y={8} width={VB_W - 16} height={38} rx={9}
              fill="#fff" stroke="#d9d3c4" />
        <text x={ORCH_X + 14} y={24} fontSize="12" fontWeight="600" fill="#16213a">
          Student
        </text>
        <text x={ORCH_X + 14} y={38} fontSize="10" fill="#46557a">
          {res.student?.detail}
        </text>
        <line x1={ORCH_X + ORCH_W / 2} y1={46} x2={ORCH_X + ORCH_W / 2} y2={ROW_Y0 - 2}
              stroke={orchLive ? AGENT_COLORS.orchestrator : '#9aa3b8'} strokeWidth="1.6"
              className={orchLive ? 'edge-live' : ''}
              markerEnd="url(#ah-46557a)" />
      </g>

      {/* orchestrator: a vertical bus every route leaves from */}
      <g onClick={() => onSelect('orchestrator')} className="cursor-pointer">
        <title>Orchestrator - deterministic code: routing, consent gate, crop, model scheduling</title>
        <rect x={ORCH_X} y={ROW_Y0} width={ORCH_W} height={orchBottom - ROW_Y0} rx={10}
              fill={orchLive ? AGENT_COLORS.orchestrator : '#26324f'}
              stroke={selected === 'orchestrator' ? '#fab219' : 'none'} strokeWidth="2.5"
              className={orchLive ? 'node-live' : ''} />
        <text transform={`translate(${ORCH_X + 20} ${(ROW_Y0 + orchBottom) / 2}) rotate(-90)`}
              textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#fff"
              letterSpacing="2">ORCHESTRATOR</text>
        <text transform={`translate(${ORCH_X + 34} ${(ROW_Y0 + orchBottom) / 2}) rotate(-90)`}
              textAnchor="middle" fontSize="9" fill="#c9d3ea">
          {orchLive ? `${activeRuns.length} run${activeRuns.length > 1 ? 's' : ''} in flight`
            : 'code, not a model'}
        </text>
      </g>

      {/* orchestrator -> agent routes */}
      {agents.map((a) => {
        const key = `orchestrator>${a.id}`
        const planned = a.status === 'planned'
        const cls = edgeClass(key)
        const color = cls ? AGENT_COLORS[a.id] : '#9aa3b8'
        return (
          <line key={key} x1={ORCH_X + ORCH_W} y1={cy(a.id)} x2={NODE_X - 2} y2={cy(a.id)}
                stroke={color} strokeWidth={cls ? 2 : 1.3}
                strokeDasharray={planned ? '3 3' : undefined}
                className={cls} opacity={planned ? 0.6 : 1}
                markerEnd={`url(#ah-${(cls ? AGENT_COLORS[a.id] : '#46557a').slice(1)})`} />
        )
      })}

      {/* hand-off arcs */}
      {arcs.map((arc) => {
        const cls = edgeClass(arc.key)
        return (
          <path key={arc.key} d={arc.d} fill="none"
                stroke={cls ? arc.color : '#b4bccd'} strokeWidth={cls ? 2 : 1.2}
                className={cls}
                markerEnd={`url(#ah-${(cls ? arc.color : '#46557a').slice(1)})`}>
            <title>{arc.title}</title>
          </path>
        )
      })}

      {/* agent nodes */}
      {agents.map((a) => {
        const y = ROW_Y0 + rows[a.id] * ROW_STEP
        const planned = a.status === 'planned'
        const live = !!running[a.id]
        const f = flash[a.id]
        const color = AGENT_COLORS[a.id] || '#46557a'
        const stroke = live ? color
          : f === 'error' ? '#d03b3b'
            : f === 'ok' ? '#0ca30c'
              : selected === a.id ? '#fab219' : '#d9d3c4'
        const s = stats[a.id]
        const model = modelOf(a)
        return (
          <g key={a.id} onClick={() => onSelect(a.id)} className="cursor-pointer"
             opacity={planned ? 0.55 : 1}>
            <title>{`${a.name}\n${a.role}\nInvoked by: ${a.invoked_by}`}</title>
            <rect x={NODE_X} y={y} width={NODE_W} height={ROW_H} rx={10}
                  fill={live ? `${color}12` : '#fff'} stroke={stroke}
                  strokeWidth={live || f || selected === a.id ? 2.2 : 1}
                  strokeDasharray={planned ? '4 3' : undefined}
                  className={live ? 'node-live' : ''} />
            <circle cx={NODE_X + 14} cy={y + 17} r={5} fill={color} />
            <text x={NODE_X + 26} y={y + 21} fontSize="12" fontWeight="650" fill="#16213a">
              {AGENT_SHORT[a.id] || a.name}
            </text>
            <text x={NODE_X + 12} y={y + 38} fontSize="9.5" fill="#46557a"
                  fontFamily="ui-monospace, Consolas, monospace">
              {model.length > 30 ? `${model.slice(0, 29)}…` : model}
            </text>
            <text x={NODE_X + NODE_W - 10} y={y + 21} fontSize="10" textAnchor="end"
                  fill={live ? color : f === 'error' ? '#d03b3b' : '#46557a'}
                  fontWeight={live ? 600 : 400}>
              {live ? 'running…' : f === 'error' ? 'failed'
                : s ? `${s.calls}×` : planned ? '' : 'idle'}
            </text>
            {!live && s?.last_ms != null && (
              <text x={NODE_X + NODE_W - 10} y={y + 38} fontSize="9.5" textAnchor="end"
                    fill="#46557a">
                last {fmtMs(s.last_ms)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
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

function Flows({ flows }) {
  return (
    <details className="mt-3 text-[11px]" open>
      <summary className="cursor-pointer font-medium text-ink">
        How each request is orchestrated
      </summary>
      <ol className="mt-1.5 space-y-1.5">
        {flows.map((f) => (
          <li key={f.id} className="leading-4">
            <span className="font-semibold text-ink">{f.name}: </span>
            <span className="text-ink-soft">{f.steps.join(' → ')}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/* ------------------------------------------------------------------ log */

function LogCard({ feed, selected, onClearFilter }) {
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
        ) : shown.map((e) => <LogRow key={e.seq} e={e} />)}
      </div>
    </Card>
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

const KIND_ICON = {
  'agent.start': '▶', 'agent.end': '■', 'agent.output': '→', 'agent.error': '✗',
  route: '↳', 'model.call': '⚙', 'model.first_token': '⚙', 'model.evict': '⇣',
  'model.retry': '↻', 'guard.block': '⛔', 'consent.blocked': '🔒', 'run.error': '✗',
}

function LogRow({ e }) {
  if (e.kind === 'run.start') {
    return (
      <div className="mb-1 mt-2.5 border-t border-dashed border-black/10 pt-1.5 font-sans first:mt-0
                      first:border-0 first:pt-0">
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
