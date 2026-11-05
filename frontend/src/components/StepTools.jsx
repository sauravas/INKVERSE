import { useCallback, useRef, useState } from 'react'
import AnswerSheet, { RichText, stepToText, stepsToText } from './AnswerSheet'
import LinedInput from './LinedInput'
import MicButton from './MicButton'
import MiniPad from './MiniPad'
import { canSpeak, speak, speakableStep } from '../lib/speak'
import { streamSteps } from '../lib/api'
import { resolveCircle } from '../lib/circle'

/**
 * Follow-up questions about one step, kept as a thread in the margin.
 *
 * Ask by tapping a diagram block, typing, writing, or (where wired) speaking.
 * Every answer stays; the next question carries the earlier turns as context,
 * so "why not the other way round?" refers to what was just said.
 */
export function useStepQuestions({ question, steps, questionId, provider, consent }) {
  const padRef = useRef(null)
  const [asking, setAsking] = useState(null)
  const [askText, setAskText] = useState('')
  // what the student circled in the step being asked about, if anything
  const [focus, setFocus] = useState('')
  // step index -> [{ id, ask, steps, streaming, error, instant }]
  const [explanations, setExplanationsState] = useState({})
  // the latest threads, readable synchronously when composing a follow-up
  const latest = useRef({})
  const nextId = useRef(0)
  const setExplanations = useCallback((v) => {
    setExplanationsState((p) => {
      const next = typeof v === 'function' ? v(p) : v
      latest.current = next
      return next
    })
  }, [])

  // patch by id, never by position: two quick questions must not collide
  const patchTurn = (index, id, fields) => setExplanations((p) => ({
    ...p, [index]: (p[index] || []).map((t) => (t.id === id ? { ...t, ...fields } : t)),
  }))

  /** Ask about `step`. Appends a turn and streams its answer into it. */
  const send = useCallback((step, text, png = null, { voice = false, label, focus: about = '' } = {}) => {
    const ask = (text || '').trim()
    if (!step || (!ask && !png)) return
    const id = ++nextId.current
    const history = (latest.current[step.index] || [])
      .filter((t) => !t.error && t.steps?.length)
      .map((t) => ({ ask: t.ask, answer: stepsToText(t.steps) }))
    setExplanations((p) => ({ ...p, [step.index]: [...(p[step.index] || []),
      { id, ask: label || ask || '(handwritten)', about, steps: [], streaming: true }] }))
    const n = id
    let built = []
    streamSteps('/api/ai/explain', {
      question, answer: stepsToText(steps),
      step: stepToText(step), step_index: step.index,
      ask, ask_image: png, question_id: questionId, history, focus: about,
      provider, consent_cloud: !!consent,
    }, {
      onEvent: (ev) => {
        if (ev.type === 'ask' && !label) patchTurn(step.index, n, { ask: ev.value })
      },
      onSteps: (st) => { built = st; patchTurn(step.index, n, { steps: st }) },
      onNotice: (note) => patchTurn(step.index, n, { notice: note }),
      onDone: () => {
        patchTurn(step.index, n, { streaming: false })
        // a question asked aloud gets its answer read back
        if (voice && canSpeak()) speak(built.map(speakableStep))
      },
      onError: (e) => patchTurn(step.index, n, { streaming: false, error: e.message }),
    })
  }, [question, steps, questionId, provider, consent, setExplanations])

  const submitAsk = useCallback(() => {
    if (!asking) return
    const png = padRef.current?.isEmpty() ? null : padRef.current?.toPng()
    send(asking, askText, png, { focus })
    setAsking(null); setAskText(''); setFocus(''); padRef.current?.clear()
  }, [asking, askText, focus, send])

  const cancel = () => { setAsking(null); setAskText(''); setFocus(''); padRef.current?.clear() }

  /**
   * A loop was drawn over the answer inside `root`. Work out what it enclosed
   * and open the ask box at that step. Returns false if it circled nothing.
   */
  const circled = useCallback((root, poly) => {
    const hit = root && resolveCircle(root, poly)
    const step = hit && steps.find((x) => x.index === hit.stepIndex)
    if (!step) return false
    setAsking(step)
    setFocus(hit.focus)
    return true
  }, [steps])

  /** Tapping a block in a diagram asks about that block straight away. */
  const askBlock = useCallback((step, label) => {
    send(step, `Explain the "${label}" block in this diagram: what it does and why it is there.`)
  }, [send])

  /** Pass as AnswerSheet's afterStep to put the thread and ask box in place. */
  const afterStep = (s) => (
    <>
      {explanations[s.index]?.length > 0 && (
        <MarginNote index={s.index} turns={explanations[s.index]}
                    onFollowUp={(text, voice, label) => send(s, text, null, { voice, label })} />
      )}
      {asking?.index === s.index && (
        <AskInline step={s} padRef={padRef} text={askText} setText={setAskText}
                   onSubmit={submitAsk} onCancel={cancel}
                   focus={focus}
                   onSpoken={(text) => { send(s, text, null, { voice: true, focus }); cancel() }}
                   onQuick={(prompt, label) => { send(s, prompt, null, { label, focus }); cancel() }} />
      )}
    </>
  )

  return { asking, setAsking, explanations, setExplanations, afterStep, askBlock, send, circled }
}

// one-tap follow-ups: the doubts students actually have about a step
export const QUICK_ASKS = [
  ['Simpler, please', 'Explain this step more simply, as if to a beginner, with one small example.'],
  ['Another method', 'Show a different way to do this step, and say when it is the better choice.'],
  ['Why this formula?', 'Why is this formula or rule used here? State it, and show why it applies.'],
  ['Common mistakes', 'What mistakes do students commonly make in this step, and how do I avoid them?'],
]

function QuickAsks({ onAsk, small }) {
  return (
    <div className="lined-row flex flex-wrap items-center gap-1.5">
      {QUICK_ASKS.map(([label, prompt]) => (
        <button key={label} type="button" onClick={() => onAsk(prompt, label)}
                className={`rounded-full bg-white px-2 leading-6 text-amber-900 ring-1
                            ring-amber-300 hover:bg-amber-100 ${small ? 'text-[11px]' : 'text-xs'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** Build thread state from stored explanation rows. */
export function threadsFromRows(rows) {
  const out = {}
  let id = -1
  for (const e of rows || []) {
    if (e.step_index == null) continue
    ;(out[e.step_index] ||= []).push({
      id: id--, ask: e.ask, steps: e.steps || [], instant: true })
  }
  return out
}

export function MarginNote({ index, turns, ex, onFollowUp }) {
  const list = turns || (ex ? [ex] : [])
  const [text, setText] = useState('')
  const busy = list.some((t) => t.streaming)
  return (
    <div className="ml-6 rounded-lg border-l-4 border-amber-400 bg-amber-50/60 px-4">
      <div className="lined-row text-[11px] font-medium uppercase tracking-wide text-amber-900/80">
        About step {index}
      </div>
      {list.map((t, i) => (
        <div key={i}>
          {t.about && (
            <p className="lined-row truncate text-[11px] text-orange-800">circled: {t.about}</p>
          )}
          <RichText text={t.ask} className="hand lined-row block text-[1.2rem] text-amber-950" />
          {t.notice && <p className="lined-row text-[11px] text-ink-soft">{t.notice}</p>}
          {t.error
            ? <p className="lined-row text-sm text-red-700">{t.error}</p>
            : <AnswerSheet steps={t.steps || []} streaming={t.streaming}
                           instant={t.instant} dense emptyHint="Thinking…" />}
        </div>
      ))}
      {onFollowUp && !busy && (
        <QuickAsks small onAsk={(prompt, label) => onFollowUp(prompt, false, label)} />
      )}
      {onFollowUp && !busy && (
        <LinedInput value={text} onChange={setText} size="small"
                    placeholder="ask a follow-up — type or tap the mic"
                    onSubmit={() => { onFollowUp(text); setText('') }}>
          <MicButton size="sm" title="Ask the follow-up aloud"
                     onText={(c, p) => setText(`${c}${p ? ` ${p}` : ''}`)}
                     onDone={(spoken) => { onFollowUp(spoken, true); setText('') }} />
          <button onClick={() => { if (text.trim()) { onFollowUp(text); setText('') } }}
                  className="rounded px-2 text-xs text-accent hover:underline">ask</button>
        </LinedInput>
      )}
    </div>
  )
}

export function AskInline({ step, padRef, text, setText, onSubmit, onCancel, onSpoken, onQuick,
                           focus }) {
  return (
    // a ring, not a border: a border's 2px would push everything below off the rules
    <div className="ml-6 rounded-lg bg-amber-50/70 px-4 ring-1 ring-amber-300">
      <div className="lined-row flex items-center gap-2">
        <span className="text-xs font-medium">
          Ask about {step.final ? 'the final answer' : `step ${step.index}`}
        </span>
        <button onClick={onCancel}
                className="ml-auto text-xs text-ink-soft hover:underline">cancel</button>
      </div>
      {focus && (
        <p className="lined-row truncate text-xs text-orange-800">
          You circled <RichText text={focus} className="hand text-[1.1rem]" />
        </p>
      )}
      {onQuick && <QuickAsks onAsk={onQuick} />}
      <MiniPad ref={padRef} height={96}
               placeholder="write your question here — or type it below" />
      <LinedInput value={text} onChange={setText} onSubmit={onSubmit}
                  placeholder="…or type it, or tap the mic" autoFocus>
        {onSpoken && (
          <MicButton size="sm" title="Ask aloud"
                     onText={(c, p) => setText(`${c}${p ? ` ${p}` : ''}`)}
                     onDone={onSpoken} />
        )}
        <button onClick={onSubmit}
                className="rounded-lg bg-accent px-3 py-1 text-sm text-white">Explain</button>
      </LinedInput>
    </div>
  )
}

/** What an answer drew on: the student's own material, and the web if enabled. */
export function SourcesNote({ items, notices }) {
  const own = (items || []).filter((s) => s.kind !== 'web')
  const web = (items || []).filter((s) => s.kind === 'web')
  if (!own.length && !web.length && !notices?.length) return null
  const names = [...new Set(own.map((s) => s.heading || 'your notes'))]
  return (
    <div className="lined-row flex flex-wrap items-center gap-1.5 text-[11px] text-ink-soft">
      {(names.length > 0 || web.length > 0) && <span>Grounded in</span>}
      {names.map((n) => (
        <span key={n} title={own.find((s) => (s.heading || 'your notes') === n)?.snippet}
              className="rounded-full bg-emerald-50 px-2 leading-5 text-emerald-800
                         ring-1 ring-emerald-200">
          {n}
        </span>
      ))}
      {web.map((w) => (
        <a key={w.url} href={w.url} target="_blank" rel="noreferrer" title={w.snippet}
           className="rounded-full bg-sky-50 px-2 leading-5 text-sky-800 ring-1
                      ring-sky-200 hover:underline">
          {w.site}: {w.title}
        </a>
      ))}
      {(notices || []).map((n) => <span key={n} className="text-ink-soft/80">{n}</span>)}
    </div>
  )
}
