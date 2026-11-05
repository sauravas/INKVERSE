import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AgentRails from './components/AgentRails'
import AnswerSheet, {
  RichText, stepToText, stepsFromEvents, stepsToText,
} from './components/AnswerSheet'
import CircleLayer, { CircleToggle } from './components/CircleLayer'
import Dashboard from './components/Dashboard'
import ImportView from './components/ImportView'
import NotesStudy from './components/NotesStudy'
import RevisionView from './components/RevisionView'
import InkCanvas from './components/InkCanvas'
import LinedInput from './components/LinedInput'
import MicButton from './components/MicButton'
import PairPanel from './components/PairPanel'
import { PenTools, ToolBtn } from './components/PenTools'
import PracticeView from './components/PracticeView'
import { SourcesNote, useStepQuestions } from './components/StepTools'
import { api, streamSteps } from './lib/api'
import { PEN_COLORS } from './lib/ink'
import { useWorkspace } from './lib/sync'
import { applyChoice, differences } from './lib/clarify'
import { canSpeak, speak, speakableStep } from './lib/speak'

const ROOM_KEY = 'inkwise.room'
const WEB_KEY = 'inkwise.web'
const SPEAK_KEY = 'inkwise.speak'
const VIEWS = [
  ['notebook', 'Notebook'], ['notes', 'Notes'], ['practice', 'Question bank'],
  ['revise', 'Revise'], ['dashboard', 'Dashboard'], ['import', 'Import'],
]
// question-bank answer pages live in the same workspace, prefixed with q-
const isQuestionPage = (p) => !!p?.id?.startsWith('q-')

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
  const deskRef = useRef(null)   // the desk around the page hosts the agent rails

  const [view, setView] = useState('notebook')
  // Calm mode stops every looping animation. The model and the browser share
  // one integrated GPU on this class of laptop, so while an answer is being
  // generated the compositor can be starved enough to flash the window. There
  // is nothing the page can do about the contention itself; it can stop adding
  // to it. Remembered, because someone who needs it needs it every time.
  const [calm, setCalm] = useState(
    () => localStorage.getItem('inkwise.calm') === '1')
  useEffect(() => {
    document.documentElement.classList.toggle('calm', calm)
    localStorage.setItem('inkwise.calm', calm ? '1' : '0')
  }, [calm])

  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(PEN_COLORS[0])
  const [size, setSize] = useState(2.4)
  const [pages, setPages] = useState([])
  const [active, setActive] = useState(0)
  const [inkCount, setInkCount] = useState(0)
  const [showPair, setShowPair] = useState(false)
  const freePageRef = useRef(null)

  // --- AI state (kept entirely out of the writing path) -------------------
  const [provider, setProvider] = useState('local')
  const [providers, setProviders] = useState([])
  const [health, setHealth] = useState(null)
  const [phase, setPhase] = useState('idle')  // idle|extracting|review|solving|done
  const [extracted, setExtracted] = useState(null)
  const [questionText, setQuestionText] = useState('')
  // a question typed (or dictated) straight onto the page, on the lines
  const [typed, setTyped] = useState('')
  // what has been asked and answered in this sitting, for "now integrate that"
  const sessionLog = useRef([])
  const lastSteps = useRef([])
  // voice: dictation into the question box, and answers read back
  const dictBase = useRef(null)
  const voiceTurn = useRef(false)
  const stopSpeaking = useRef(() => {})
  const [autoSolve, setAutoSolve] = useState(false)
  const [speakAll, setSpeakAll] = useState(() => localStorage.getItem(SPEAK_KEY) === '1')
  const toggleSpeak = () => {
    localStorage.setItem(SPEAK_KEY, speakAll ? '0' : '1')
    if (speakAll) stopSpeaking.current()
    setSpeakAll(!speakAll)
  }
  const [steps, setSteps] = useState([])
  const [sources, setSources] = useState([])
  const [notices, setNotices] = useState([])
  // off by default: turning it on sends question text to Wikipedia/DuckDuckGo
  const [web, setWeb] = useState(() => localStorage.getItem(WEB_KEY) === '1')
  const toggleWeb = () => {
    if (!web && !window.confirm(
      'Web search looks your question up on Wikipedia and DuckDuckGo for '
      + 'up-to-date facts. That sends the question text to them (never your '
      + 'handwriting or notes). Turn it on?')) return
    localStorage.setItem(WEB_KEY, web ? '0' : '1')
    setWeb(!web)
  }
  const [err, setErr] = useState(null)
  const [stats, setStats] = useState(null)
  const [questionId, setQuestionId] = useState(null)
  const [selectedStep, setSelectedStep] = useState(null)
  const [toast, setToast] = useState(null)
  const [circling, setCircling] = useState(false)
  const [missed, setMissed] = useState(false)
  const answerRef = useRef(null)
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

  const onPagesChange = useCallback((p, a) => {
    setPages(p); setActive(a)
    if (p[a] && !isQuestionPage(p[a])) freePageRef.current = p[a].id
  }, [])
  const onInkChange = useCallback((n) => setInkCount(n), [])

  // Leaving the question bank leaves the workspace on a question's page; the
  // free notebook must not open onto someone's practice answer.
  useEffect(() => {
    if (view !== 'notebook') return
    if (isQuestionPage(pages[active])) {
      const target = freePageRef.current
        || pages.find((p) => !isQuestionPage(p))?.id || 'notebook'
      sync.send({ t: 'page_open', id: target, title: 'Notebook' })
    }
  }, [view, pages, active, sync])

  const consent = useMemo(
    () => providers.find((p) => p.name === provider)?.requires_consent,
    [providers, provider])

  const ask = useStepQuestions({
    question: questionText, steps, questionId, provider, consent,
  })

  // --- solve pipeline -----------------------------------------------------
  const readPage = async () => {
    setErr(null)
    const png = canvas.current?.toPng()
    if (!png) { setErr('Nothing is written on this page yet.'); return }
    setPhase('extracting')
    setSteps([]); setSources([]); setStats(null); setQuestionId(null)
    ask.setExplanations({}); setSelectedStep(null)
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

  const solve = (explicit) => {
    let q = (typeof explicit === 'string' ? explicit : questionText).trim()
    if (!q) return
    stopSpeaking.current()
    setAutoSolve(false)
    if (typeof explicit === 'string') {
      setQuestionText(q); setQuestionId(null); setExtracted(null)
      ask.setExplanations({}); setSelectedStep(null)
    } else if (extracted?.diagram) {
      // a drawing in the question is part of the question
      q = `${q}\n\n(The student's page also shows a drawing: ${extracted.diagram})`
    }
    setErr(null); setPhase('solving'); setSteps([]); setSources([]); setNotices([])
    setStats(null)
    abortRef.current = streamSteps('/api/ai/solve', {
      question: q, subject: extracted?.subject_guess || '',
      provider, consent_cloud: !!consent, question_id: questionId, web,
      session: sessionLog.current.slice(-3),
    }, {
      onSteps: (st) => { setSteps(st); lastSteps.current = st },
      onSources: setSources,
      onNotice: (n) => setNotices((x) => [...x, n]),
      onDone: (s) => {
        setStats(s); setPhase('done')
        // remember the question and its result for follow-on questions
        const final = lastSteps.current.find((x) => x.final) || lastSteps.current.at(-1)
        sessionLog.current = [...sessionLog.current, {
          question: q, answer: final ? stepToText(final) : '' }].slice(-6)
        // asked by voice (or always, if chosen): read the answer back
        if ((voiceTurn.current || speakAll) && canSpeak()) {
          stopSpeaking.current = speak(lastSteps.current.map(speakableStep))
        }
        voiceTurn.current = false
      },
      onError: (e) => { setErr(e.message); setPhase('idle') },
    })
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

  // Open a filed question on the page, with whatever answer it already has.
  // Shared by the dashboard and the revision queue so they cannot drift.
  const openQuestion = (q) => {
    setQuestionText(q.text); setQuestionId(q.id)
    try {
      const s = q.answer_json ? JSON.parse(q.answer_json) : (q.answer_steps || [])
      setSteps(s); setStats(null); setPhase(s.length ? 'done' : 'review')
    } catch { setSteps([]); setPhase('review') }
    setSources([]); ask.setExplanations({}); setSelectedStep(null)
    setView('notebook')
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
    if (view !== 'notebook') return undefined
    const onKey = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); canvas.current?.undo()
      } else if (mod && (e.key.toLowerCase() === 'y'
                 || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); canvas.current?.redo()
      } else if (mod && e.key === 'Enter') {
        e.preventDefault(); if (phase === 'idle' || phase === 'done') solveOrRead()
      } else if (e.key === 'e') setTool('eraser')
      else if (e.key === 'p') setTool('pen')
      else if (e.key === 'h') setTool('highlighter')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const busy = phase === 'extracting' || phase === 'solving'
  const ai = { provider, consent, web }
  // Solve answers the typed question if there is one, else reads the page
  const solveOrRead = () => (typed.trim() ? solve(typed) : readPage())

  // spoken words go into the question box as they are recognised
  const onDictText = (committed, partial) => {
    if (dictBase.current === null) dictBase.current = typed ? `${typed.trim()} ` : ''
    setAutoSolve(false)
    setTyped(`${dictBase.current}${committed}${partial ? ` ${partial}` : ''}`.trimStart())
  }
  const onDictDone = (text) => {
    const full = `${dictBase.current ?? ''}${text}`.trim()
    dictBase.current = null
    setTyped(full)
    voiceTurn.current = true
    setAutoSolve(true)               // solve shortly, unless the student edits it
  }
  useEffect(() => {
    if (!autoSolve || !typed.trim() || busy) return undefined
    const t = setTimeout(() => solve(typed), 2000)
    return () => clearTimeout(t)
  }, [autoSolve, typed, busy])      // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      <TopBar
        view={view} setView={setView} calm={calm} onToggleCalm={() => setCalm((c) => !c)}
        sync={sync} onPair={() => setShowPair(true)}
        provider={provider} setProvider={setProvider} providers={providers}
        health={health} onRefreshHealth={refreshHealth}
        web={web} onToggleWeb={toggleWeb}
        speakAll={speakAll} onToggleSpeak={toggleSpeak}
      />

      {view === 'dashboard' && <Dashboard onOpenQuestion={openQuestion} />}

      {view === 'revise' && (
        <RevisionView
          onOpenQuestion={async (q) => {
            // the queue carries the question, not its answer; fetch the rest
            try {
              const full = await api.question(q.id)
              openQuestion(full)
            } catch { openQuestion(q) }
          }}
          onPractiseModule={() => setView('practice')} />
      )}

      {view === 'notes' && <NotesStudy ai={ai} />}

      {view === 'import' && (
        <ImportView onPractise={() => setView('practice')}
                    onNotes={() => setView('notes')} />
      )}

      {view === 'practice' && (
        <PracticeView sync={sync} ai={ai} tool={tool} setTool={setTool}
                      color={color} setColor={setColor} size={size} setSize={setSize}
                      onImport={() => setView('import')} />
      )}

      {view === 'notebook' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <Toolbar
            tool={tool} setTool={setTool} color={color} setColor={setColor}
            size={size} setSize={setSize} canvas={canvas}
            pages={pages} active={active} inkCount={inkCount}
            busy={busy} onSolve={solveOrRead} onStop={stop}
            canSolve={inkCount > 0 || typed.trim().length > 0}
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

          {/* the desk: page in the middle, agent graph and log in the margins */}
          <div ref={deskRef} className="relative flex min-h-0 flex-1 flex-col">
          <AgentRails hostRef={deskRef} provider={provider} />
          {/* the notebook: question written on top, answer written below it */}
          <div ref={sheetRef}
               className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[#eceadf] py-5">
            <div data-paper
                 className="ruled mx-auto rounded-sm shadow-[0_2px_24px_rgba(28,25,18,0.13)]
                            ring-1 ring-paper-edge"
                 style={{ width: 'min(94%, 880px)' }}>
              <div className="border-l-2 border-margin/70" style={{ marginLeft: '8%' }}>
                {/* writing area: height tracks the ink, not a fixed page */}
                <InkCanvas
                  ref={canvas} sync={sync} tool={tool} color={color} size={size}
                  showRule={false} fitWidth
                  onPagesChange={onPagesChange} onInkChange={onInkChange}
                />
                <LinedInput value={typed} className="px-5"
                            onChange={(v) => { setTyped(v); setAutoSolve(false) }}
                            placeholder="…or type or say your question, and press Enter"
                            onSubmit={() => solve(typed)} disabled={busy}>
                  <MicButton onText={onDictText} onDone={onDictDone}
                             title="Ask by voice — stop talking and it solves" />
                </LinedInput>
                {autoSolve && typed.trim() && !busy && (
                  <p className="lined-row px-5 text-xs text-ink-soft">
                    solving in 2 seconds… change the text to stop it
                  </p>
                )}

                {(steps.length > 0 || busy) && (
                  <div data-answer-start className="px-5 pb-[var(--rule)]">
                    <div className="lined-row flex items-baseline gap-2">
                      <span className="hand lined-text text-[1.6rem] text-emerald-800">Answer</span>
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
                      {steps.length > 0 && (
                        <CircleToggle on={circling} missed={missed}
                                      onChange={(v) => { setCircling(v); setMissed(false) }} />
                      )}
                    </div>
                    <SourcesNote items={sources} notices={notices} />

                    <div ref={answerRef} className="relative">
                    <CircleLayer active={circling} resetKey={questionText}
                                 onCircle={(poly) => {
                                   const ok = ask.circled(answerRef.current, poly)
                                   setMissed(!ok)
                                   if (ok) setCircling(false)
                                 }} />
                    <AnswerSheet
                      steps={steps}
                      streaming={phase === 'solving'}
                      instant={phase === 'done' && !stats}
                      selectedStep={selectedStep}
                      onSelectStep={setSelectedStep}
                      onAskStep={(s) => { setSelectedStep(s); ask.setAsking(s) }}
                      emptyHint=" "
                      afterStep={ask.afterStep}
                      onAskBlock={ask.askBlock}
                    />
                    </div>
                  </div>
                )}

                {steps.length === 0 && !busy && (
                  <p className="hand lined-text px-5 pb-[var(--rule)] text-[1.35rem] text-ink-soft/45">
                    {inkCount > 0
                      ? 'Press Solve — the answer will be written here.'
                      : 'Write or type a question above, then press Solve.'}
                  </p>
                )}
              </div>
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
                 calm, onToggleCalm,
                  health, onRefreshHealth, web, onToggleWeb, speakAll, onToggleSpeak }) {
  const phones = sync.peers.filter((p) => p.role === 'phone').length
  const dot = sync.status === 'live' ? '#0ca30c'
    : sync.status === 'offline' ? '#d03b3b' : '#fab219'

  return (
    <header className="flex items-center gap-3 border-b border-black/10 bg-[#fbf9f3] px-4 py-2">
      <span className="hand text-2xl tracking-wide">INKWISE</span>

      <nav className="ml-3 flex gap-1 rounded-lg bg-black/5 p-0.5 text-sm">
        {VIEWS.map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
                  className={`whitespace-nowrap rounded-md px-3 py-1 ${
                    view === v ? 'bg-white shadow-sm' : 'text-ink-soft'}`}>
            {label}
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
        <button onClick={onToggleWeb}
                title={web ? 'Web search on: questions are also looked up on Wikipedia '
                  + 'and DuckDuckGo' : 'Web search off: answers use only this machine'}
                className={`rounded-lg px-2 py-1 ${web
                  ? 'bg-sky-50 text-sky-800 ring-1 ring-sky-300' : 'text-ink-soft hover:bg-black/5'}`}>
          🌐 Web {web ? 'on' : 'off'}
        </button>
        {canSpeak() && (
          <button onClick={onToggleSpeak}
                  title={speakAll ? 'Every answer is read aloud (on this laptop\'s own voice)'
                    : 'Answers are read aloud only when you ask by voice'}
                  className={`rounded-lg px-2 py-1 ${speakAll
                    ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-300'
                    : 'text-ink-soft hover:bg-black/5'}`}>
            {speakAll ? '🔊 Read aloud' : '🔈 Voice replies'}
          </button>
        )}
        <button onClick={onToggleCalm}
                title={calm
                  ? 'Calm mode on: no looping animations. Use this if the screen '
                    + 'flickers while an answer is being written - the model and '
                    + 'the display share one graphics chip.'
                  : 'Calm mode off: the pen, the diagrams and the agent rails animate'}
                className={`rounded-lg px-2 py-1 ${calm
                  ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-300'
                  : 'text-ink-soft hover:bg-black/5'}`}>
          {calm ? '🌙 Calm' : '✨ Motion'}
        </button>
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
                   pages, active, inkCount, busy, onSolve, onStop, canSolve,
                   canSave, onSaveStudy, onSaveNotebook }) {
  const freePages = pages.filter((p) => !isQuestionPage(p))
  const pos = freePages.findIndex((p) => p.id === pages[active]?.id)
  return (
    <div className="scroll-thin flex items-center gap-1 overflow-x-auto border-b
                    border-black/10 bg-[#fbf9f3] px-3 py-1.5">
      <PenTools tool={tool} setTool={setTool} color={color} setColor={setColor}
                size={size} setSize={setSize} canvas={canvas} />
      <ToolBtn onClick={() => canvas.current?.addPage()}>+ Page</ToolBtn>
      <span className="shrink-0 whitespace-nowrap px-1 text-xs text-ink-soft">
        {Math.max(1, pos + 1)}/{freePages.length || 1} · {inkCount} strokes
      </span>
      <ToolBtn onClick={onSaveNotebook} title="Save notebook to disk">💾</ToolBtn>

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
          <button onClick={onSolve} disabled={!canSolve}
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
  // question-bank pages are reached from the question bank, not listed here
  const free = pages.map((p, i) => ({ p, i })).filter(({ p }) => !isQuestionPage(p))
  if (free.length <= 1) return null
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-t border-black/10
                    bg-[#fbf9f3] px-3 py-1.5">
      {free.map(({ p, i }, n) => (
        <button key={p.id} onClick={() => canvas.current?.selectPage(i)}
                className={`shrink-0 rounded px-2 py-1 text-xs ${
                  i === active ? 'bg-ink text-white' : 'bg-black/5 hover:bg-black/10'}`}>
          {n + 1}
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
  // where the two readings disagree, as specific questions for the student
  const diffs = useMemo(
    () => (alt ? differences(extracted.question, alt) : []), [alt, extracted?.question])
  const [picked, setPicked] = useState({})
  const choose = (i, useTheirs) => {
    const next = { ...picked, [i]: useTheirs }
    setPicked(next)
    // re-apply every choice to the first reading, right to left so the token
    // positions of earlier differences stay valid
    let text = extracted.question
    diffs.map((d, j) => [d, j]).sort((a, b) => b[0].at[0] - a[0].at[0])
      .forEach(([d, j]) => { if (next[j]) text = applyChoice(text, d, true) })
    onChange(text)
  }
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

        {diffs.length > 0 && (
          // ask about the exact spot, not "here are two sentences, compare them"
          <div className="mb-2 space-y-1.5 rounded-lg bg-white/70 px-3 py-2 ring-1 ring-amber-400">
            <div className="text-[11px] font-medium text-amber-900">
              I'm not sure what you wrote {diffs.length === 1 ? 'here' : 'in these places'}:
            </div>
            {diffs.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 text-sm">
                {d.before && <span className="text-ink-soft">…{d.before}</span>}
                {[[false, d.mine], [true, d.theirs]].map(([theirs, txt]) => (
                  <button key={String(theirs)} type="button" onClick={() => choose(i, theirs)}
                          className={`rounded-md px-2 py-0.5 ring-1 ${
                            (picked[i] ?? false) === theirs
                              ? 'bg-amber-200 ring-amber-500' : 'bg-white ring-amber-300 hover:bg-amber-50'}`}>
                    {txt ? <RichText text={txt} className="hand text-[1.15rem]" />
                      : <span className="text-xs text-ink-soft">(nothing)</span>}
                  </button>
                ))}
                <span className="text-ink-soft">?</span>
              </div>
            ))}
          </div>
        )}
        {!diffs.length && low && (
          <p className="mb-2 text-[12px] text-amber-900">
            Parts of this were hard to read. Fix anything wrong below, or write it
            again more clearly and press Read again.
          </p>
        )}

        <div className="rounded-lg bg-white/70 px-1 ring-1 ring-amber-300">
          <LinedInput value={value} onChange={onChange} onSubmit={onSolve} minLines={2} />
        </div>
        {/\$|\\\(/.test(value) && (
          // how the maths will actually read, so a wrong exponent is visible
          <p className="mt-1 text-[11px] text-amber-900/80">
            reads as: <RichText text={value} className="hand text-[1.15rem] text-ink" />
          </p>
        )}
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
