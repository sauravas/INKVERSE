import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamSteps } from '../lib/api'
import AnswerSheet, { WrittenText } from './AnswerSheet'
import InkCanvas from './InkCanvas'
import { useLibraryVersion } from '../lib/library'
import NotesView from './NotesView'
import { PenTools } from './PenTools'
import CircleLayer, { CircleToggle } from './CircleLayer'
import { SourcesNote, threadsFromRows, useStepQuestions } from './StepTools'

const OUTCOMES = [
  ['knew', 'I knew it', 'bg-emerald-600'],
  ['hint', 'Needed the hint', 'bg-amber-500'],
  ['answer', 'Needed the answer', 'bg-red-600'],
]

/**
 * The question-bank notebook.
 *
 * Start a module and each question is written onto the page; the student
 * answers underneath by pen or phone. Stuck? A hint first. Still stuck? The
 * worked answer is written in below. Every step can be annotated, and the
 * attempt is kept, so the module becomes the student's own reference notes.
 */
export default function PracticeView({ sync, ai, onImport, ...pen }) {
  const [mode, setMode] = useState('pick')       // pick|session|notes
  const [module, setModule] = useState(null)
  const [subjects, setSubjects] = useState(null)
  const [report, setReport] = useState(null)

  const load = useCallback(() => {
    Promise.all([api.subjects(), api.dashboard()])
      .then(([s, d]) => { setSubjects(s); setReport(d) })
      .catch(() => setSubjects([]))
  }, [])
  // an imported question bank should be here to practise immediately
  const libraryVersion = useLibraryVersion()
  useEffect(() => { if (mode === 'pick') load() }, [mode, load, libraryVersion])

  if (mode === 'session' && module) {
    return <Session module={module} sync={sync} ai={ai} pen={pen}
                    onExit={() => setMode('pick')} onNotes={() => setMode('notes')} />
  }
  if (mode === 'notes' && module) {
    return <NotesView query={{ module_id: module.id }} onBack={() => setMode('pick')} />
  }
  return <Picker subjects={subjects} report={report} onImport={onImport}
                 onStart={(m) => { setModule(m); setMode('session') }}
                 onNotes={(m) => { setModule(m); setMode('notes') }}
                 onReload={load} />
}

/* ------------------------------------------------------------- module list */

function Picker({ subjects, report, onStart, onNotes, onImport, onReload }) {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState(null)

  const openFriendsNotes = async (file) => {
    if (!file) return
    setMsg(null)
    try {
      const bundle = JSON.parse(await file.text())
      const who = window.prompt('Whose notes are these? (shown on the subject)',
                                bundle.shared_by || '') || ''
      const r = await api.importBundle(bundle, who)
      setMsg({ ok: true, text: `Added ${r.questions} questions in ${r.modules} module(s) — ${r.origin}.` })
      onReload?.()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof SyntaxError
        ? 'That file is not an INKWISE notes file.' : e.message })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!subjects) return <div className="p-10 text-center text-sm text-ink-soft">Loading…</div>
  const stats = (sid, mid) => report?.subjects.find((r) => r.subject.id === sid)
    ?.modules.find((m) => m.id === mid)
  const withQuestions = subjects.filter((s) => s.question_count > 0)

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-[#f4f2ea] px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Question bank</h1>
            <p className="text-sm text-ink-soft">
              Work through a module one question at a time. Try first — a hint is
              there if you are stuck, and the full answer after that.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={() => fileRef.current?.click()}
                    className="rounded-lg border border-black/15 px-3 py-2 text-sm hover:bg-black/5">
              Open a friend's notes
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                   onChange={(e) => openFriendsNotes(e.target.files?.[0])} />
            <button onClick={onImport}
                    className="rounded-lg bg-ink px-3 py-2 text-sm text-white">
              Import questions
            </button>
          </div>
        </header>
        {msg && (
          <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.ok
            ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>
        )}

        {withQuestions.length === 0 && (
          <div className="rounded-xl border border-dashed border-black/15 px-6 py-10 text-center">
            <p className="hand text-2xl text-ink-soft">No questions yet.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
              Import a question bank or past paper — PDF, DOCX, text, or a photo of a
              printed page.
            </p>
            <button onClick={onImport}
                    className="mt-4 rounded-lg bg-ink px-3 py-2 text-sm text-white">
              Import a question bank
            </button>
          </div>
        )}

        <div className="space-y-4">
          {withQuestions.map((s) => (
            <section key={s.id} className="rounded-xl border border-black/10 bg-[#fbf9f3]">
              <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2.5">
                <h2 className="font-semibold">{s.name}</h2>
                {s.origin && (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px]
                                   text-violet-800 ring-1 ring-violet-200">{s.origin}</span>
                )}
              </div>
              <ul className="divide-y divide-black/5">
                {s.modules.map((m) => {
                  const st = stats(s.id, m.id)
                  const total = st?.total ?? 0
                  const done = total - (st?.counts?.pending ?? total)
                  if (!total) return null
                  return (
                    <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{m.name}</div>
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-1.5 w-40 rounded bg-black/[0.07]">
                            <div className="h-full rounded bg-[#2a78d6]"
                                 style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
                          </div>
                          <span className="text-[11px] tabular-nums text-ink-soft">
                            {done}/{total} attempted
                          </span>
                        </div>
                      </div>
                      <button onClick={() => onNotes({ ...m, subject: s })}
                              className="rounded-lg border border-black/15 px-3 py-1.5 text-sm
                                         hover:bg-black/5">
                        My answers
                      </button>
                      <button onClick={() => onStart({ ...m, subject: s })}
                              className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white">
                        {done === 0 ? 'Start module' : done >= total ? 'Practise again' : 'Continue'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- session */

function Session({ module, sync, ai, pen, onExit, onNotes }) {
  const canvas = useRef(null)
  const sheetRef = useRef(null)
  const [list, setList] = useState(null)
  const [idx, setIdx] = useState(0)
  const [detail, setDetail] = useState(null)
  const [marking, setMarking] = useState(null)   // {steps, streaming, verdict}
  const [hint, setHint] = useState(null)         // {steps, streaming, sources}
  const [answer, setAnswer] = useState(null)     // {steps, streaming, sources, instant}
  const [choosing, setChoosing] = useState(false)
  const [finished, setFinished] = useState({})   // qid -> outcome, this session
  const [err, setErr] = useState(null)
  const [inkCount, setInkCount] = useState(0)
  const [circling, setCircling] = useState(false)
  const [missed, setMissed] = useState(false)
  const answerRef = useRef(null)
  const abortRef = useRef(null)
  // latest streamed steps, read when a stream finishes (never inside updaters)
  const hintSteps = useRef([])
  const answerSteps = useRef([])

  const q = list?.questions[idx]
  const ask = useStepQuestions({
    question: q?.text || '', steps: answer?.steps || [], questionId: q?.id,
    provider: ai.provider, consent: ai.consent,
  })

  // load the module, resuming at the first unfinished question
  useEffect(() => {
    api.practiceModule(module.id).then((s) => {
      setList(s)
      setIdx(Math.min(s.resume_index, Math.max(0, s.questions.length - 1)))
    }).catch((e) => setErr(e.message))
  }, [module.id])

  // open each question: its own shared page, its saved work, a fresh pen
  useEffect(() => {
    if (!q) return undefined
    let dead = false
    abortRef.current?.()
    setHint(null); setAnswer(null); setMarking(null)
    setChoosing(false); setErr(null); setDetail(null)
    api.practiceQuestion(q.id).then((d) => {
      if (dead) return
      setDetail(d)
      ask.setExplanations(threadsFromRows(d.explanations))
      // laptop and phone both land on this question's answer page
      sync.send({ t: 'page_open', id: `q-${q.id}`, title: `Q${idx + 1}`,
                  strokes: d.attempt?.strokes || [] })
      sheetRef.current?.scrollTo({ top: 0 })
    }).catch((e) => setErr(e.message))
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.id])

  /** Save what is on the page now. Captured synchronously, before any page switch. */
  const saveWork = useCallback((extra = {}) => {
    if (!q || !canvas.current) return Promise.resolve()
    const strokes = canvas.current.getStrokes()
      .map(({ pointerId, remote, ...s }) => s)      // eslint-disable-line no-unused-vars
    if (!strokes.length && !extra.hint_steps) return Promise.resolve()
    return api.saveAttempt(q.id, {
      strokes, image: strokes.length ? canvas.current.toPng({ pad: 20, minSide: 40 }) : null, ...extra,
    }).catch(() => {})
  }, [q])

  const go = (to) => {
    saveWork()
    if (to >= list.questions.length) { setIdx(list.questions.length); return }
    setIdx(Math.max(0, to))
  }

  const getHint = () => {
    if (detail?.attempt?.hint_steps?.length) {
      setHint({ steps: detail.attempt.hint_steps, instant: true }); return
    }
    hintSteps.current = []
    setHint({ steps: [], streaming: true })
    abortRef.current = streamSteps('/api/ai/hint', {
      question: q.text, question_id: q.id,
      provider: ai.provider, consent_cloud: !!ai.consent,
    }, {
      onSteps: (st) => { hintSteps.current = st; setHint((h) => ({ ...h, steps: st })) },
      onSources: (items) => setHint((h) => ({ ...h, sources: items })),
      onNotice: (n) => setHint((h) => ({ ...h, notices: [...(h.notices || []), n] })),
      onDone: () => {
        const st = hintSteps.current
        setHint((h) => ({ ...h, streaming: false }))
        saveWork({ hint_steps: st })
        setDetail((d) => d && ({ ...d, attempt: { ...(d.attempt || {}), hint_steps: st } }))
      },
      onError: (e) => { setErr(e.message); setHint(null) },
    })
  }

  const showAnswer = () => {
    saveWork()
    if (detail?.answer_steps?.length) {
      // already worked out once: show it, do not spend another minute on it
      setAnswer({ steps: detail.answer_steps, instant: true }); return
    }
    answerSteps.current = []
    setAnswer({ steps: [], streaming: true })
    abortRef.current = streamSteps('/api/ai/solve', {
      question: q.text, question_id: q.id,
      provider: ai.provider, consent_cloud: !!ai.consent, web: !!ai.web,
    }, {
      onSteps: (st) => { answerSteps.current = st; setAnswer((a) => ({ ...a, steps: st })) },
      onSources: (items) => setAnswer((a) => ({ ...a, sources: items })),
      onNotice: (n) => setAnswer((a) => ({ ...a, notices: [...(a.notices || []), n] })),
      onDone: () => {
        const st = answerSteps.current
        setAnswer((a) => ({ ...a, streaming: false }))
        setDetail((d) => d && ({ ...d, answer_steps: st }))
      },
      onError: (e) => { setErr(e.message); setAnswer(null) },
    })
  }

  useEffect(() => {
    if (answer?.streaming) {
      sheetRef.current?.querySelector('[data-answer]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [answer?.streaming])

  // Ask the Examiner to mark what is actually on the page. The attempt is
  // saved first, so the marking is of the same working the notes will keep.
  const markMine = async () => {
    setErr(null)
    const strokes = canvas.current?.getStrokes?.() || []
    if (!strokes.length) {
      setErr('Write your attempt on the page first - there is nothing to mark.')
      return
    }
    await saveWork()                       // mark exactly what gets kept
    const image = canvas.current.toPng({ pad: 20, minSide: 40 })
    setMarking({ steps: [], streaming: true })
    const steps = { current: [] }
    streamSteps(`/api/practice/question/${q.id}/mark`,
      { image, marks: q.marks ? Number(q.marks) || null : null },
      {
        onEvent: (ev) => {
          if (ev.type === 'transcript') {
            setMarking((m) => ({ ...m, transcript: ev.value }))
          } else if (ev.type === 'marked') {
            setMarking((m) => ({ ...m, verdict: ev }))
          }
        },
        onSteps: (st) => { steps.current = st; setMarking((m) => ({ ...m, steps: st })) },
        onDone: () => setMarking((m) => ({ ...m, streaming: false })),
        onError: (e) => { setErr(e.message); setMarking(null) },
      })
  }

  const finish = async (outcome) => {
    setChoosing(false)
    await saveWork()
    try {
      await api.finishQuestion(q.id, outcome)
      setFinished((f) => ({ ...f, [q.id]: outcome }))
      go(idx + 1)
    } catch (e) { setErr(e.message) }
  }

  const exit = () => { saveWork(); onExit() }

  if (!list) {
    return <div className="p-10 text-center text-sm text-ink-soft">{err || 'Loading…'}</div>
  }
  if (!list.questions.length) {
    return <div className="p-10 text-center text-sm text-ink-soft">
      This module has no questions. <button onClick={onExit} className="underline">Back</button>
    </div>
  }

  // end of the module
  if (idx >= list.questions.length) {
    const tally = Object.values(finished).reduce((t, o) => ({ ...t, [o]: (t[o] || 0) + 1 }), {})
    return (
      <div className="flex h-full items-center justify-center bg-[#f4f2ea] p-6">
        <div className="max-w-md rounded-xl border border-black/10 bg-[#fbf9f3] px-6 py-6 text-center">
          <p className="hand text-3xl">Module done</p>
          <p className="mt-1 text-sm text-ink-soft">{module.name}</p>
          <div className="mt-4 flex justify-center gap-4 text-sm">
            {OUTCOMES.map(([k, label]) => (
              <div key={k}><div className="text-2xl font-semibold tabular-nums">
                {tally[k] || 0}</div><div className="text-[11px] text-ink-soft">{label}</div></div>
            ))}
          </div>
          <div className="mt-5 flex justify-center gap-2">
            <button onClick={onNotes} className="rounded-lg bg-ink px-3 py-2 text-sm text-white">
              See my answers
            </button>
            <button onClick={() => setIdx(0)}
                    className="rounded-lg border border-black/15 px-3 py-2 text-sm">
              Go through again
            </button>
            <button onClick={onExit} className="rounded-lg px-3 py-2 text-sm text-ink-soft">
              Modules
            </button>
          </div>
        </div>
      </div>
    )
  }

  const suggested = answer ? 'answer' : hint ? 'hint' : 'knew'
  const busy = hint?.streaming || answer?.streaming || marking?.streaming

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* where you are */}
      <div className="flex items-center gap-3 border-b border-black/10 bg-[#fbf9f3] px-4 py-2 text-sm">
        <button onClick={exit} className="text-ink-soft hover:text-ink">← Modules</button>
        <span className="truncate text-ink-soft">
          {module.subject?.name} · <span className="text-ink">{module.name}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          {list.questions.map((x, i) => {
            const o = finished[x.id] || x.outcome
            return (
              <button key={x.id} onClick={() => go(i)} title={`Question ${i + 1}`}
                      className={`h-2.5 w-2.5 rounded-full ring-offset-1 ${
                        i === idx ? 'ring-2 ring-ink' : ''} ${
                        o === 'knew' ? 'bg-emerald-600' : o === 'hint' ? 'bg-amber-500'
                          : o === 'answer' ? 'bg-red-600' : 'bg-black/15'}`} />
            )
          })}
        </div>
        <span className="tabular-nums text-ink-soft">{idx + 1}/{list.questions.length}</span>
        <button onClick={() => { saveWork(); onNotes() }}
                className="rounded-lg border border-black/15 px-2.5 py-1 hover:bg-black/5">
          My answers
        </button>
      </div>

      <div className="scroll-thin flex items-center gap-1 overflow-x-auto border-b
                      border-black/10 bg-[#fbf9f3] px-3 py-1.5">
        <PenTools {...pen} canvas={canvas} />
        <span className="ml-auto shrink-0 text-xs text-ink-soft">
          {inkCount ? `${inkCount} strokes · saved as you go` : 'write your answer below'}
        </span>
      </div>

      {err && <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{err}</div>}

      <div ref={sheetRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[#eceadf] py-5">
        <div className="ruled mx-auto rounded-sm shadow-[0_2px_24px_rgba(28,25,18,0.13)]
                        ring-1 ring-paper-edge" style={{ width: 'min(94%, 880px)' }}>
          <div className="border-l-2 border-margin/70" style={{ marginLeft: '8%' }}>
            {/* the question, written onto the page */}
            <div className="px-5 pt-[var(--rule)]">
              <div className="lined-row flex items-center gap-2 text-[11px] uppercase tracking-wide
                              text-ink-soft/70">
                <span>Question {idx + 1}</span>
                {q.marks && <span className="rounded bg-black/5 px-1.5 normal-case">{q.marks} marks</span>}
                {q.important ? <span style={{ color: '#b07800' }}>★ important</span> : null}
              </div>
              <WrittenText key={q.id} text={q.text}
                           className="hand lined-text block text-[1.6rem] text-ink" />
            </div>

            <div className="lined-row flex items-baseline gap-2 px-5">
              <span className="hand lined-text text-[1.3rem] text-ink-soft">Your answer</span>
            </div>
            <InkCanvas ref={canvas} sync={sync} tool={pen.tool} color={pen.color}
                       size={pen.size} showRule={false} fitWidth
                       onInkChange={setInkCount} />

            {hint && (
              <div className="mx-5 rounded-lg border-l-4 border-amber-400 bg-amber-50/70 px-4">
                <SourcesNote items={hint.sources} notices={hint.notices} />
                <AnswerSheet steps={hint.steps} streaming={hint.streaming}
                             instant={hint.instant} dense emptyHint="Thinking of a hint…" />
              </div>
            )}

            {marking && (
              <div className="mx-5 mb-2 rounded-lg border-l-4 border-violet-400
                              bg-violet-50/70 px-4 pb-2">
                <div className="lined-row flex items-baseline gap-3">
                  <span className="hand lined-text text-[1.5rem] text-violet-900">
                    Marked
                  </span>
                  {marking.verdict && (
                    <span className="text-sm font-medium tabular-nums text-violet-900">
                      {marking.verdict.awarded}/{marking.verdict.available}
                      <span className="ml-2 font-normal text-violet-800/80">
                        {marking.verdict.verdict}
                      </span>
                    </span>
                  )}
                  {marking.streaming && (
                    <span className="text-xs text-ink-soft">marking…</span>
                  )}
                </div>
                {marking.transcript && (
                  <details className="mb-1 text-xs text-ink-soft">
                    <summary className="cursor-pointer">
                      what the Reader saw on your page
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
                      {marking.transcript}
                    </pre>
                  </details>
                )}
                <AnswerSheet steps={marking.steps} streaming={marking.streaming}
                             dense emptyHint="Reading your working…" />
                {marking.verdict?.next && (
                  <p className="lined-row text-sm text-violet-900">
                    <span className="font-medium">Fix first: </span>
                    {marking.verdict.next}
                  </p>
                )}
                <p className="pb-1 text-[11px] text-ink-soft">
                  Recorded as one recall attempt. Your readiness is still worked
                  out from your records, not from this mark.
                </p>
              </div>
            )}

            {answer && (
              <div data-answer className="px-5 pb-[var(--rule)]">
                <div className="lined-row flex items-baseline">
                  <span className="hand lined-text text-[1.6rem] text-emerald-800">Answer</span>
                  {answer.steps.length > 0 && (
                    <CircleToggle on={circling} missed={missed}
                                  onChange={(v) => { setCircling(v); setMissed(false) }} />
                  )}
                </div>
                <SourcesNote items={answer.sources} notices={answer.notices} />
                <div ref={answerRef} className="relative">
                  <CircleLayer active={circling} resetKey={q.id}
                               onCircle={(poly) => {
                                 const ok = ask.circled(answerRef.current, poly)
                                 setMissed(!ok)
                                 if (ok) setCircling(false)
                               }} />
                  <AnswerSheet steps={answer.steps} streaming={answer.streaming}
                               instant={answer.instant} emptyHint="Working it out…"
                               onAskStep={(s) => ask.setAsking(s)}
                               afterStep={ask.afterStep} onAskBlock={ask.askBlock} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* what to do next */}
      <div className="flex flex-wrap items-center gap-2 border-t border-black/10 bg-[#fbf9f3] px-4 py-2.5">
        <button onClick={() => go(idx - 1)} disabled={idx === 0}
                className="rounded-lg px-2.5 py-1.5 text-sm text-ink-soft disabled:opacity-30">
          ← Previous
        </button>

        {choosing ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-soft">How did it go?</span>
            {OUTCOMES.map(([k, label, bg]) => (
              <button key={k} onClick={() => finish(k)}
                      className={`rounded-lg px-3 py-1.5 text-sm ${k === suggested
                        ? `${bg} text-white` : 'border border-black/15 hover:bg-black/5'}`}>
                {label}
              </button>
            ))}
            <button onClick={() => setChoosing(false)} className="text-xs text-ink-soft">cancel</button>
          </div>
        ) : (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!hint && !answer && (
              <button onClick={getHint} disabled={busy}
                      className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm
                                 text-amber-900 hover:bg-amber-100">
                I'm stuck — give me a hint
              </button>
            )}
            {!marking && (
              <button onClick={markMine} disabled={busy}
                      className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5
                                 text-sm text-violet-900 hover:bg-violet-100">
                Mark what I wrote
              </button>
            )}
            {!answer && (
              <button onClick={showAnswer} disabled={busy}
                      className={hint
                        ? 'rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800'
                        : 'px-2 py-1.5 text-xs text-ink-soft hover:underline'}>
                {hint ? 'Still stuck — show the answer' : 'skip to the answer'}
              </button>
            )}
            <button onClick={() => setChoosing(true)} disabled={busy}
                    className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-40">
              {idx + 1 === list.questions.length ? 'Done — finish module' : 'Done — next question →'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
