import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AnswerSheet, {
  RichText, stepToText, stepsFromEvents, stepsToText,
} from './components/AnswerSheet'
import Dashboard from './components/Dashboard'
import InkCanvas from './components/InkCanvas'
import MiniPad from './components/MiniPad'
import PairPanel from './components/PairPanel'
import { api, streamEvents } from './lib/api'
import { PEN_COLORS } from './lib/ink'
import { useWorkspace } from './lib/sync'

const ROOM_KEY = 'inkwise.room'

function initialRoom() {
  const q = new URLSearchParams(location.search).get('room')
  if (q) { localStorage.setItem(ROOM_KEY, q); return q }
  let r = localStorage.getItem(ROOM_KEY)
  if (!r) {
    r = Math.random().toString(36).slice(2, 10)
    localStorage.setItem(ROOM_KEY, r)
  }
  return r
}

export default function App() {
  const [room] = useState(initialRoom)
  const sync = useWorkspace(room, 'laptop')
  const canvas = useRef(null)
  const sheetRef = useRef(null)

  const [view, setView] = useState('notebook')
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(PEN_COLORS[0])
  const [size, setSize] = useState(2.4)
  const [pages, setPages] = useState([])
  const [active, setActive] = useState(0)
  const [inkCount, setInkCount] = useState(0)
  const [showPair, setShowPair] = useState(false)

  // --- AI state (kept entirely out of the writing path) -------------------
  const [provider, setProvider] = useState('local')
  const [providers, setProviders] = useState([])
  const [health, setHealth] = useState(null)
  const [phase, setPhase] = useState('idle')  // idle|extracting|review|solving|done
  const [extracted, setExtracted] = useState(null)
  const [questionText, setQuestionText] = useState('')
  const [steps, setSteps] = useState([])
  const [err, setErr] = useState(null)
  const [stats, setStats] = useState(null)
  const [questionId, setQuestionId] = useState(null)
  const [selectedStep, setSelectedStep] = useState(null)
  const [asking, setAsking] = useState(null)
  const [explanations, setExplanations] = useState({})
  const [toast, setToast] = useState(null)
  const abortRef = useRef(null)

  useEffect(() => {
    api.providers().then((p) => {
      setProviders(p.providers)
      setProvider(p.default === 'ollama' ? 'local' : p.default)
    }).catch(() => {})
  }, [])

  const refreshHealth = useCallback(() => {
    api.aiHealth(provider).then(setHealth).catch(() => setHealth(null))
  }, [provider])
  useEffect(() => { refreshHealth() }, [refreshHealth])

  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const onPagesChange = useCallback((p, a) => { setPages(p); setActive(a) }, [])
  const onInkChange = useCallback((n) => setInkCount(n), [])

  const consent = useMemo(
    () => providers.find((p) => p.name === provider)?.requires_consent,
    [providers, provider])

  // --- solve pipeline -----------------------------------------------------
  const readPage = async () => {
    setErr(null)
    const png = canvas.current?.toPng()
    if (!png) { setErr('Nothing is written on this page yet.'); return }
    setPhase('extracting')
    setSteps([]); setStats(null); setQuestionId(null)
    setExplanations({}); setSelectedStep(null)
    try {
      if (consent && !window.confirm(
        'This sends your handwritten page to Google Gemini, off this machine. Continue?')) {
        setPhase('idle'); return
      }
      const out = await api.extract({ image: png, provider, consent_cloud: !!consent })
      if (out.blank || !out.question) {
        setErr(out.note || 'Could not read a question on this page.')
        setPhase('idle'); return
      }
      setExtracted(out)
      setQuestionText(out.question)
      setPhase('review')
    } catch (e) {
      setErr(e.message); setPhase('idle')
    }
  }

  const solve = () => {
    const q = questionText.trim()
    if (!q) return
    setErr(null); setPhase('solving'); setSteps([]); setStats(null)
    const acc = []
    abortRef.current = streamEvents('/api/ai/solve', {
      question: q, subject: extracted?.subject_guess || '',
      provider, consent_cloud: !!consent, question_id: questionId,
    }, (ev) => {
      if (ev.type === 'error') { setErr(ev.message); setPhase('idle'); return }
      if (ev.type === 'done') {
        setStats({ ttft: ev.ttft_s, total: ev.total_s }); setPhase('done'); return
      }
      if (ev.type === 'step_open' || ev.type === 'segment') {
        acc.push(ev)
        setSteps(stepsFromEvents(acc))
      }
    }, (e) => { setErr(e.message); setPhase('idle') })
  }

  const stop = () => { abortRef.current?.(); setPhase(steps.length ? 'done' : 'idle') }

  const saveToStudy = async () => {
    try {
      const q = await api.createQuestion({
        text: questionText.trim(),
        answer_md: stepsToText(steps),
        answer_json: JSON.stringify(steps),
        status: 'studied',
      })
      setQuestionId(q.id)
      setErr(null)
      setToast('Saved to dashboard as "Studied".')
    } catch (e) { setErr(e.message) }
  }

  // --- follow-up on one step ---------------------------------------------
  const padRef = useRef(null)
  const [askText, setAskText] = useState('')

  const submitAsk = async () => {
    const step = asking
    if (!step) return
    const png = padRef.current?.isEmpty() ? null : padRef.current?.toPng()
    const text = askText.trim()
    if (!png && !text) return

    setExplanations((p) => ({
      ...p, [step.index]: { ask: text || '(handwritten)', steps: [], streaming: true },
    }))
    const acc = []
    streamEvents('/api/ai/explain', {
      question: questionText, answer: stepsToText(steps),
      step: stepToText(step), step_index: step.index,
      ask: text, ask_image: png, question_id: questionId,
      provider, consent_cloud: !!consent,
    }, (ev) => {
      if (ev.type === 'ask') {
        setExplanations((p) => ({
          ...p, [step.index]: { ...p[step.index], ask: ev.value } }))
        return
      }
      if (ev.type === 'error') {
        setExplanations((p) => ({
          ...p, [step.index]: { ...p[step.index], streaming: false, error: ev.message } }))
        return
      }
      if (ev.type === 'done') {
        setExplanations((p) => ({
          ...p, [step.index]: { ...p[step.index], streaming: false } }))
        return
      }
      if (ev.type === 'step_open' || ev.type === 'segment') {
        acc.push(ev)
        const built = stepsFromEvents(acc)
        setExplanations((p) => ({ ...p, [step.index]: { ...p[step.index], steps: built } }))
      }
    }, (e) => {
      setExplanations((p) => ({
        ...p, [step.index]: { ...p[step.index], streaming: false, error: e.message } }))
    })

    setAsking(null); setAskText(''); padRef.current?.clear()
  }

  // bring the answer into view as soon as the pen starts
  useEffect(() => {
    if (phase === 'solving' && sheetRef.current) {
      sheetRef.current.querySelector('[data-answer-start]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [phase])

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); canvas.current?.undo()
      } else if (mod && (e.key.toLowerCase() === 'y'
                 || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); canvas.current?.redo()
      } else if (mod && e.key === 'Enter') {
        e.preventDefault(); if (phase === 'idle' || phase === 'done') readPage()
      } else if (e.key === 'e') setTool('eraser')
      else if (e.key === 'p') setTool('pen')
      else if (e.key === 'h') setTool('highlighter')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const busy = phase === 'extracting' || phase === 'solving'

  return (
    <div className="flex h-full flex-col">
      <TopBar
        view={view} setView={setView}
        sync={sync} onPair={() => setShowPair(true)}
        provider={provider} setProvider={setProvider} providers={providers}
        health={health} onRefreshHealth={refreshHealth}
      />

      {view === 'dashboard' ? (
        <Dashboard onOpenQuestion={(q) => {
          setQuestionText(q.text); setQuestionId(q.id)
          try {
            const s = q.answer_json ? JSON.parse(q.answer_json) : []
            setSteps(s); setStats(null); setPhase(s.length ? 'done' : 'review')
          } catch { setSteps([]); setPhase('review') }
          setExplanations({}); setSelectedStep(null)
          setView('notebook')
        }} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <Toolbar
            tool={tool} setTool={setTool} color={color} setColor={setColor}
            size={size} setSize={setSize} canvas={canvas}
            pages={pages} active={active} inkCount={inkCount}
            busy={busy} phase={phase} stats={stats}
            onSolve={readPage} onStop={stop}
            canSave={steps.length > 0 && !questionId}
            onSaveStudy={saveToStudy}
            onSaveNotebook={async () => {
              try { await api.saveRoom(room); setToast('Notebook saved.') }
              catch (e) { setErr(e.message) }
            }}
          />

          {phase === 'review' && (
            <ReviewBar
              extracted={extracted} value={questionText}
              onChange={setQuestionText} onSolve={solve} onReread={readPage}
              onCancel={() => setPhase('idle')}
            />
          )}
          {err && (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {err}
            </div>
          )}

          {/* the notebook: question written on top, answer written below it */}
          <div ref={sheetRef}
               className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[#eceadf] py-5">
            <div className="ruled mx-auto rounded-sm shadow-[0_2px_24px_rgba(28,25,18,0.13)]
                            ring-1 ring-paper-edge"
                 style={{ width: 'min(94%, 880px)' }}>
              <div className="border-l-2 border-margin/70" style={{ marginLeft: '8%' }}>
                {/* writing area: height tracks the ink, not a fixed page */}
                <InkCanvas
                  ref={canvas} sync={sync} tool={tool} color={color} size={size}
                  showRule={false} fitWidth
                  onPagesChange={onPagesChange} onInkChange={onInkChange}
                />

                {(steps.length > 0 || busy) && (
                  <div data-answer-start className="px-5 pb-10 pt-2">
                    <div className="mb-2 flex items-center gap-2 border-t border-dashed
                                    border-rule pt-3">
                      <span className="hand text-[1.6rem] text-emerald-800">Answer</span>
                      {stats && (
                        <span className="text-[11px] text-ink-soft/70">
                          first ink {stats.ttft}s · {stats.total}s
                        </span>
                      )}
                      {phase === 'extracting' && (
                        <span className="text-xs text-ink-soft">
                          reading your handwriting…
                        </span>
                      )}
                    </div>

                    <AnswerSheet
                      steps={steps}
                      streaming={phase === 'solving'}
                      instant={phase === 'done' && !stats}
                      selectedStep={selectedStep}
                      onSelectStep={setSelectedStep}
                      onAskStep={(s) => { setSelectedStep(s); setAsking(s) }}
                      emptyHint=" "
                      afterStep={(s) => (
                        <>
                          {explanations[s.index] && (
                            <MarginNote index={s.index} ex={explanations[s.index]} />
                          )}
                          {asking?.index === s.index && (
                            <AskInline
                              step={s} padRef={padRef} text={askText}
                              setText={setAskText} onSubmit={submitAsk}
                              onCancel={() => {
                                setAsking(null); setAskText(''); padRef.current?.clear()
                              }}
                            />
                          )}
                        </>
                      )}
                    />
                  </div>
                )}

                {steps.length === 0 && !busy && (
                  <p className="hand px-5 pb-8 pt-3 text-[1.35rem] text-ink-soft/45">
                    {inkCount > 0
                      ? 'Press Solve — the answer will be written here.'
                      : 'Write a question above, then press Solve.'}
                  </p>
                )}
              </div>
            </div>
          </div>

          <PageStrip pages={pages} active={active} canvas={canvas} />
        </div>
      )}

      {showPair && (
        <PairPanel room={room} peers={sync.peers} status={sync.status}
                   latency={sync.latency} onClose={() => setShowPair(false)} />
      )}
      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg
                        bg-ink px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- bars */

function TopBar({ view, setView, sync, onPair, provider, setProvider, providers,
                  health, onRefreshHealth }) {
  const phones = sync.peers.filter((p) => p.role === 'phone').length
  const dot = sync.status === 'live' ? '#0ca30c'
    : sync.status === 'offline' ? '#d03b3b' : '#fab219'

  return (
    <header className="flex items-center gap-3 border-b border-black/10 bg-[#fbf9f3] px-4 py-2">
      <span className="hand text-2xl tracking-wide">INKWISE</span>

      <nav className="ml-3 flex gap-1 rounded-lg bg-black/5 p-0.5 text-sm">
        {['notebook', 'dashboard'].map((v) => (
          <button key={v} onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1 capitalize ${
                    view === v ? 'bg-white shadow-sm' : 'text-ink-soft'}`}>
            {v}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3 text-xs">
        <ModelPill health={health} onRefresh={onRefreshHealth} />
        <select value={provider} onChange={(e) => setProvider(e.target.value)}
                className="rounded border border-black/10 bg-white px-2 py-1 text-xs">
          {providers.map((p) => (
            <option key={p.name} value={p.name} disabled={!p.configured}>
              {p.label}{p.configured ? '' : ' (no key)'}
            </option>
          ))}
        </select>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
          {sync.status}{sync.latency != null && sync.status === 'live'
            ? ` ${sync.latency}ms` : ''}
        </span>
        <button onClick={onPair}
                className="rounded-lg border border-black/15 px-2.5 py-1 hover:bg-black/5">
          {phones ? `📱 ${phones} connected` : '📱 Connect phone'}
        </button>
      </div>
    </header>
  )
}

function ModelPill({ health, onRefresh }) {
  const [busy, setBusy] = useState(false)
  if (!health) return null
  const loaded = health.loaded || []
  const free = health.memory?.free_gb

  const unload = async () => {
    setBusy(true)
    try { await api.unload() } finally { setBusy(false); onRefresh() }
  }

  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-black/10
                     bg-white px-2 py-1">
      <span className={health.ok ? 'text-emerald-700' : 'text-red-700'}>
        {health.ok ? '●' : '○'}
      </span>
      <span className="text-ink-soft">
        {health.stages
          ? (health.stages.staged
            ? `${health.stages.vision} → ${health.stages.text}`
            : health.stages.text)
          : health.model}
      </span>
      {free != null && <span className="text-ink-soft/70">{free}GB free</span>}
      {loaded.length > 0 && (
        <button onClick={unload} disabled={busy} title={`Loaded: ${loaded.join(', ')}`}
                className="rounded bg-black/5 px-1.5 hover:bg-black/10">
          {busy ? '…' : 'unload'}
        </button>
      )}
    </span>
  )
}

function Toolbar({ tool, setTool, color, setColor, size, setSize, canvas,
                   pages, active, inkCount, busy, phase, stats, onSolve, onStop,
                   canSave, onSaveStudy, onSaveNotebook }) {
  const Btn = ({ on, children, ...p }) => (
    <button {...p}
      className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${
        on ? 'bg-ink text-white' : 'hover:bg-black/5'}`}>{children}</button>
  )
  return (
    <div className="scroll-thin flex items-center gap-1 overflow-x-auto border-b
                    border-black/10 bg-[#fbf9f3] px-3 py-1.5">
      <Btn on={tool === 'pen'} onClick={() => setTool('pen')} title="Pen (p)">✒︎ Pen</Btn>
      <Btn on={tool === 'highlighter'} onClick={() => setTool('highlighter')}
           title="Highlighter (h)">▭ Mark</Btn>
      <Btn on={tool === 'eraser'} onClick={() => setTool('eraser')}
           title="Eraser (e)">⌫ Erase</Btn>

      <span className="mx-1 h-5 w-px shrink-0 bg-black/10" />
      {PEN_COLORS.map((c) => (
        <button key={c} onClick={() => { setColor(c); setTool('pen') }} title={c}
                className={`h-5 w-5 shrink-0 rounded-full ring-offset-1 ${
                  color === c ? 'ring-2 ring-ink' : 'ring-1 ring-black/15'}`}
                style={{ background: c }} />
      ))}
      <input type="range" min="1" max="6" step="0.2" value={size}
             onChange={(e) => setSize(parseFloat(e.target.value))}
             className="mx-2 w-20 shrink-0" title="Pen width" />

      <span className="mx-1 h-5 w-px shrink-0 bg-black/10" />
      <Btn onClick={() => canvas.current?.undo()} title="Undo (Ctrl+Z)">↶</Btn>
      <Btn onClick={() => canvas.current?.redo()} title="Redo (Ctrl+Y)">↷</Btn>
      <Btn onClick={() => { if (confirm('Clear this page?')) canvas.current?.clear() }}>
        Clear
      </Btn>
      <Btn onClick={() => canvas.current?.addPage()}>+ Page</Btn>
      <span className="shrink-0 whitespace-nowrap px-1 text-xs text-ink-soft">
        {active + 1}/{pages.length || 1} · {inkCount} strokes
      </span>
      <Btn onClick={onSaveNotebook} title="Save notebook to disk">💾</Btn>

      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {canSave && (
          <button onClick={onSaveStudy}
                  className="shrink-0 whitespace-nowrap rounded-lg border border-black/15
                             px-2.5 py-1.5 text-sm hover:bg-black/5">
            Save to dashboard
          </button>
        )}
        {busy ? (
          <button onClick={onStop}
                  className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white">
            Stop
          </button>
        ) : (
          <button onClick={onSolve} disabled={!inkCount}
                  className="shrink-0 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5
                             text-sm text-white disabled:opacity-40">
            Solve ⌘↵
          </button>
        )}
      </span>
    </div>
  )
}

function PageStrip({ pages, active, canvas }) {
  if (pages.length <= 1) return null
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-t border-black/10
                    bg-[#fbf9f3] px-3 py-1.5">
      {pages.map((p, i) => (
        <button key={p.id} onClick={() => canvas.current?.selectPage(i)}
                className={`shrink-0 rounded px-2 py-1 text-xs ${
                  i === active ? 'bg-ink text-white' : 'bg-black/5 hover:bg-black/10'}`}>
          {i + 1}
        </button>
      ))}
      <button onClick={() => canvas.current?.deletePage(active)}
              className="ml-2 shrink-0 rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50">
        Delete page
      </button>
    </div>
  )
}

/* -------------------------------------------------------------- answer UI */

function ReviewBar({ extracted, value, onChange, onSolve, onReread, onCancel }) {
  const conf = extracted?.confidence ?? 0
  const low = conf < 0.6
  const alt = extracted?.alternative
  return (
    <div className="border-b border-black/10 bg-amber-50/70 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-amber-900">
            Is this what you wrote?
          </span>
          <span className="text-[11px] text-amber-800/80">
            {Math.round(conf * 100)}% confident
            {extracted?.model ? ` · ${extracted.model}` : ''}
            {extracted?.latency_s ? ` · ${extracted.latency_s}s` : ''}
            {extracted?.verified ? ' · read twice' : ''}
          </span>
          {low && (
            <span className="rounded bg-amber-200 px-1.5 text-[11px] text-amber-900">
              please check carefully
            </span>
          )}
          <button onClick={onCancel}
                  className="ml-auto text-xs text-amber-900/70 hover:underline">
            cancel
          </button>
        </div>

        {alt && (
          // the two readings disagreed, so the student picks rather than us
          <div className="mb-2 rounded-lg border border-amber-400 bg-white/70 px-3 py-2">
            <div className="text-[11px] font-medium text-amber-900">
              The two readings disagreed — check the numbers:
            </div>
            <button type="button" onClick={() => onChange(alt)}
                    className="mt-1 block w-full rounded border border-amber-300
                               bg-amber-50 px-2 py-1 text-left font-mono text-[12px]
                               hover:bg-amber-100">
              {alt}
              <span className="ml-2 text-[10px] text-amber-700">use this instead</span>
            </button>
          </div>
        )}

        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2}
                  className="w-full resize-y rounded-lg border border-amber-300 bg-white
                             px-3 py-2 font-mono text-[13px] leading-5" />
        <div className="mt-2 flex gap-2">
          <button onClick={onSolve}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white">
            Looks right — solve it
          </button>
          <button onClick={onReread}
                  className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm">
            Read again
          </button>
        </div>
      </div>
    </div>
  )
}

function MarginNote({ index, ex }) {
  return (
    <div className="my-2 ml-6 rounded-lg border-l-4 border-amber-400 bg-amber-50/60
                    px-4 py-3">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide
                      text-amber-900/80">
        About step {index} — you asked
      </div>
      <RichText text={ex.ask}
                className="hand mb-2 block text-[1.2rem] leading-6 text-amber-950" />
      {ex.error
        ? <p className="text-sm text-red-700">{ex.error}</p>
        : <AnswerSheet steps={ex.steps} streaming={ex.streaming} dense />}
    </div>
  )
}

function AskInline({ step, padRef, text, setText, onSubmit, onCancel }) {
  return (
    <div className="my-2 ml-6 rounded-lg border border-amber-300 bg-amber-50/70 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium">
          Ask about {step.final ? 'the final answer' : `step ${step.index}`}
        </span>
        <button onClick={onCancel}
                className="ml-auto text-xs text-ink-soft hover:underline">cancel</button>
      </div>
      <MiniPad ref={padRef} height={88}
               placeholder="write your question here — or type it below" />
      <div className="mt-2 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
               placeholder="…or type it"
               className="flex-1 rounded-lg border border-black/15 px-3 py-1.5 text-sm" />
        <button onClick={onSubmit}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white">
          Explain
        </button>
      </div>
    </div>
  )
}
