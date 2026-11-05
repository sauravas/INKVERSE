import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useLibraryVersion } from '../lib/library'
import { RichText } from './AnswerSheet'

/**
 * What to revise next.
 *
 * Every number on this screen is calculated from the student's own records,
 * and every item says why it is where it is. That is the point: a queue a
 * student cannot interrogate is a queue they will not trust, and a model
 * guessing at it would be exactly the kind of confident wrongness that makes
 * revision advice worthless.
 */

const fmtPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)

function Bar({ value, tone = 'bg-accent' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
      <div className={`h-full rounded-full ${tone}`}
           style={{ width: `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%` }} />
    </div>
  )
}

export default function RevisionView({ onOpenQuestion, onPractiseModule }) {
  const [plan, setPlan] = useState(null)
  const [subjects, setSubjects] = useState([])
  const [subjectId, setSubjectId] = useState('')
  const [err, setErr] = useState(null)

  const libraryVersion = useLibraryVersion()
  const load = useCallback(() => {
    api.revisionPlan(subjectId || undefined, 15)
      .then((p) => { setPlan(p); setErr(null) })
      .catch((e) => setErr(e.message))
  }, [subjectId])

  useEffect(() => { load() }, [load, libraryVersion])
  useEffect(() => { api.subjects().then(setSubjects).catch(() => {}) }, [libraryVersion])

  const counts = plan?.counts || {}

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-[#f4f2ea] px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-xl font-semibold">Revise</h1>
            <p className="text-sm text-ink-soft">
              Worked out from your records, not estimated. Every item says why.
            </p>
          </div>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}
                  className="rounded-lg border border-black/15 bg-white px-2 py-1.5 text-sm">
            <option value="">Everything</option>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </header>

        {err && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</div>}

        {plan && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['Overdue', counts.due, 'text-red-700'],
              ['Being forgotten', counts.failing, 'text-amber-700'],
              ['Never tested', counts.never_tested, 'text-ink'],
              ['Flagged important', counts.important, 'text-ink']].map(([label, n, tone]) => (
                <div key={label} className="rounded-xl border border-black/10 bg-[#fbf9f3] px-4 py-3">
                  <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{n ?? 0}</div>
                  <div className="text-[11px] uppercase tracking-wide text-ink-soft">{label}</div>
                </div>
              ))}
          </div>
        )}

        {/* --- weakest topics ------------------------------------------- */}
        {!!plan?.weak_topics?.length && (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold">Weakest topics</h2>
            <ul className="space-y-2">
              {plan.weak_topics.map((w) => (
                <li key={w.module_id}
                    className="rounded-xl border border-black/10 bg-[#fbf9f3] px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-medium">{w.module}</span>
                    <span className="text-xs text-ink-soft">{w.subject}</span>
                    <span className="ml-auto text-xs tabular-nums text-ink-soft">
                      {w.questions} question{w.questions === 1 ? '' : 's'}
                    </span>
                    <button onClick={() => onPractiseModule?.(w)}
                            className="rounded-lg bg-ink px-3 py-1 text-xs text-white">
                      Practise this
                    </button>
                  </div>
                  <p className="mt-1 text-sm text-ink-soft">{w.reason}</p>
                  <div className="mt-2 grid grid-cols-3 gap-3 text-[11px] text-ink-soft">
                    {[['studied', w.coverage, 'bg-accent'],
                      ['recalled', w.recall_accuracy, 'bg-emerald-500'],
                      ['revised', w.revision_rate, 'bg-amber-500']].map(([l, v, tone]) => (
                        <div key={l}>
                          <div className="mb-1 flex justify-between">
                            <span>{l}</span><span className="tabular-nums">{fmtPct(v)}</span>
                          </div>
                          <Bar value={v} tone={tone} />
                        </div>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* --- the queue ------------------------------------------------- */}
        <section>
          <h2 className="mb-2 text-sm font-semibold">
            Next up{plan?.queue?.length ? ` · ${plan.queue.length}` : ''}
          </h2>
          {plan && !plan.queue.length && (
            <p className="rounded-xl border border-black/10 bg-[#fbf9f3] px-4 py-6 text-center
                          text-sm text-ink-soft">
              Nothing is due. Everything you have studied is either fresh or
              already mastered.
            </p>
          )}
          <ol className="space-y-2">
            {plan?.queue?.map((q, i) => (
              <li key={q.id}
                  className="flex items-start gap-3 rounded-xl border border-black/10
                             bg-[#fbf9f3] px-4 py-3">
                <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums
                                 text-ink-soft">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <RichText text={q.text} className="text-sm text-ink" />
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1
                                  text-[11px] text-ink-soft">
                    {q.important && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                        important
                      </span>
                    )}
                    <span className={q.overdue_days > 0 ? 'text-red-700' : ''}>{q.why}</span>
                    {q.recall_total > 0 && (
                      <span className="tabular-nums">
                        · {q.recall_correct}/{q.recall_total} recalled
                      </span>
                    )}
                    {q.module && <span>· {q.module}</span>}
                    {q.interval_days > 0 && (
                      <span>· next in {q.interval_days}d once you know it</span>
                    )}
                  </div>
                </div>
                <button onClick={() => onOpenQuestion?.(q)}
                        className="shrink-0 rounded-lg border border-black/15 px-3 py-1.5
                                   text-xs hover:bg-white">
                  Open
                </button>
              </li>
            ))}
          </ol>
        </section>

        {plan && (
          <p className="mt-5 text-[11px] leading-relaxed text-ink-soft">{plan.method}</p>
        )}
      </div>
    </div>
  )
}
