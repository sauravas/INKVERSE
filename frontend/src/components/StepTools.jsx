import { useCallback, useRef, useState } from 'react'
import AnswerSheet, { RichText, stepToText, stepsToText } from './AnswerSheet'
import MiniPad from './MiniPad'
import { streamSteps } from '../lib/api'

/**
 * Step annotation, shared by the free notebook and the question bank: select
 * a step, write or type a follow-up beside it, get an explanation of that
 * step only, written into the margin.
 */
export function useStepQuestions({ question, steps, questionId, provider, consent }) {
  const padRef = useRef(null)
  const [asking, setAsking] = useState(null)
  const [askText, setAskText] = useState('')
  const [explanations, setExplanations] = useState({})

  const patch = (index, fields) =>
    setExplanations((p) => ({ ...p, [index]: { ...p[index], ...fields } }))

  const submitAsk = useCallback(() => {
    const step = asking
    if (!step) return
    const png = padRef.current?.isEmpty() ? null : padRef.current?.toPng()
    const text = askText.trim()
    if (!png && !text) return

    setExplanations((p) => ({
      ...p, [step.index]: { ask: text || '(handwritten)', steps: [], streaming: true },
    }))
    streamSteps('/api/ai/explain', {
      question, answer: stepsToText(steps),
      step: stepToText(step), step_index: step.index,
      ask: text, ask_image: png, question_id: questionId,
      provider, consent_cloud: !!consent,
    }, {
      onEvent: (ev) => { if (ev.type === 'ask') patch(step.index, { ask: ev.value }) },
      onSteps: (built) => patch(step.index, { steps: built }),
      onDone: () => patch(step.index, { streaming: false }),
      onError: (e) => patch(step.index, { streaming: false, error: e.message }),
    })
    setAsking(null); setAskText(''); padRef.current?.clear()
  }, [asking, askText, question, steps, questionId, provider, consent])

  const cancel = () => { setAsking(null); setAskText(''); padRef.current?.clear() }

  /** Pass as AnswerSheet's afterStep to put notes and the ask box in place. */
  const afterStep = (s) => (
    <>
      {explanations[s.index] && <MarginNote index={s.index} ex={explanations[s.index]} />}
      {asking?.index === s.index && (
        <AskInline step={s} padRef={padRef} text={askText} setText={setAskText}
                   onSubmit={submitAsk} onCancel={cancel} />
      )}
    </>
  )

  return { asking, setAsking, explanations, setExplanations, afterStep }
}

export function MarginNote({ index, ex }) {
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
        : <AnswerSheet steps={ex.steps || []} streaming={ex.streaming}
                       instant={ex.instant} dense />}
    </div>
  )
}

export function AskInline({ step, padRef, text, setText, onSubmit, onCancel }) {
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

/** Which of the student's own imported material an answer drew on. */
export function SourcesNote({ items }) {
  if (!items?.length) return null
  const names = [...new Set(items.map((s) => s.heading || 'your notes'))]
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-soft">
      <span>Grounded in</span>
      {names.map((n) => (
        <span key={n} title={items.find((s) => (s.heading || 'your notes') === n)?.snippet}
              className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800
                         ring-1 ring-emerald-200">
          {n}
        </span>
      ))}
    </div>
  )
}
