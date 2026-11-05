import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useLibraryVersion } from '../lib/library'

/**
 * Study dashboard.
 *
 * Every number here is computed by the backend from question rows. The model is
 * never consulted about readiness (constraint 3), so EXAM READY is reproducible
 * and its blockers are always explainable.
 *
 * Colour: ordinal blue ramp (validated light->dark, single hue) for the ordered
 * pending->mastered progression; the fixed status palette for readiness, always
 * paired with an icon and a label so colour never carries meaning alone.
 */

const STATUS = ['pending', 'studied', 'revised', 'mastered']
const STATUS_LABEL = {
  pending: 'Pending', studied: 'Studied', revised: 'Revised', mastered: 'Mastered',
}
// validated ordinal ramp, single hue, light->dark (see dataviz validator)
const RAMP = {
  pending: '#86b6ef', studied: '#5598e7', revised: '#2a78d6', mastered: '#184f95',
}
const STATUS_COLOR = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' }
// White fails contrast on the two lightest ramp steps, so those carry dark ink.
const RAMP_INK = {
  pending: '#0b0b0b', studied: '#0b0b0b', revised: '#ffffff', mastered: '#ffffff',
}
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781' }

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)

export default function Dashboard({ onOpenQuestion }) {
  const [data, setData] = useState(null)
  const [subjects, setSubjects] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [openSubject, setOpenSubject] = useState(null)

  const reload = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.dashboard(), api.subjects()])
      setData(d)
      setSubjects(s)
      setErr(null)
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  // re-reads whenever anything writes to the library - an import here, a
  // question filed on the phone - so the dashboard is never a stale snapshot
  const libraryVersion = useLibraryVersion()
  useEffect(() => { reload() }, [reload, libraryVersion])

  const addSubject = async () => {
    const name = prompt('Subject name (e.g. Engineering Mathematics III)')
    if (!name?.trim()) return
    setBusy(true)
    try {
      await api.createSubject({ name: name.trim() })
      await reload()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const addModule = async (sid) => {
    const name = prompt('Module name (e.g. Laplace Transforms)')
    if (!name?.trim()) return
    setBusy(true)
    try {
      await api.createModule({ subject_id: sid, name: name.trim() })
      await reload()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  if (err) {
    return <div className="m-6 rounded bg-red-50 p-4 text-sm text-red-700">{err}</div>
  }
  if (!data) {
    return <div className="p-10 text-center text-sm text-ink-soft">Loading…</div>
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-[#f4f2ea] px-6 py-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Study dashboard</h1>
            <p className="text-sm text-ink-soft">
              Readiness is calculated from your question records, not estimated.
            </p>
          </div>
          <button onClick={addSubject} disabled={busy}
                  className="rounded-lg bg-ink px-3 py-2 text-sm text-white hover:bg-ink/90 disabled:opacity-50">
            + Subject
          </button>
        </header>

        <KpiRow overall={data.overall} subjects={data.subjects} />

        {data.subjects.length === 0 && (
          <EmptyState onAdd={addSubject} />
        )}

        <div className="mt-5 space-y-4">
          {data.subjects.map((r) => (
            <SubjectCard
              key={r.subject.id}
              report={r}
              subject={subjects.find((s) => s.id === r.subject.id)}
              expanded={openSubject === r.subject.id}
              onToggle={() => setOpenSubject(
                openSubject === r.subject.id ? null : r.subject.id)}
              onAddModule={() => addModule(r.subject.id)}
              onChanged={reload}
              onOpenQuestion={onOpenQuestion}
            />
          ))}
        </div>

        {data.overall.unfiled > 0 && (
          <UnfiledCard count={data.overall.unfiled} subjects={subjects}
                       onChanged={reload} onOpenQuestion={onOpenQuestion} />
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- KPI row */

function KpiRow({ overall, subjects }) {
  const recall = useMemo(() => {
    const c = subjects.reduce((n, s) => n + s.totals.recall_correct, 0)
    const t = subjects.reduce((n, s) => n + s.totals.recall_total, 0)
    return t ? c / t : null
  }, [subjects])

  const important = useMemo(() => {
    const d = subjects.reduce((n, s) => n + s.totals.important_mastered, 0)
    const t = subjects.reduce((n, s) => n + s.totals.important_total, 0)
    return { d, t }
  }, [subjects])

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile label="Syllabus covered" value={pct(overall.coverage)}
            sub={`${overall.questions} questions`} />
      <Tile label="Recall accuracy" value={pct(recall)}
            sub={recall == null ? 'no attempts yet' : 'across all subjects'} />
      <Tile label="Important mastered"
            value={important.t ? `${important.d}/${important.t}` : '—'}
            sub={important.t ? 'flagged questions' : 'none flagged'} />
      <Tile label="Subjects exam ready"
            value={`${overall.ready}/${overall.subjects}`}
            sub={overall.ready === overall.subjects && overall.subjects > 0
              ? 'all clear' : 'see blockers below'} />
    </div>
  )
}

function Tile({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-black/10 bg-[#fbf9f3] px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide"
           style={{ color: INK.muted }}>{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums"
           style={{ color: INK.primary }}>{value}</div>
      <div className="mt-0.5 text-[11px]" style={{ color: INK.secondary }}>{sub}</div>
    </div>
  )
}

/* ----------------------------------------------------------- subject card */

function SubjectCard({ report, subject, expanded, onToggle, onAddModule,
                       onChanged, onOpenQuestion }) {
  const m = report.metrics
  const ready = report.exam_ready

  return (
    <section className="rounded-xl border border-black/10 bg-[#fbf9f3]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button onClick={onToggle} className="flex items-center gap-2 text-left">
          <span className="text-ink-soft">{expanded ? '▾' : '▸'}</span>
          <span className="font-semibold">{report.subject.name}</span>
        </button>
        <ReadyBadge ready={ready} />
        <div className="ml-auto flex items-center gap-4 text-xs"
             style={{ color: INK.secondary }}>
          <span>{report.totals.questions} questions</span>
          <span className="tabular-nums">{pct(m.coverage)} covered</span>
          <button onClick={onAddModule}
                  className="rounded border border-black/10 px-2 py-1 hover:bg-black/5">
            + Module
          </button>
        </div>
      </div>

      <div className="px-4 pb-3">
        <StatusBar counts={report.totals.counts} total={report.totals.questions} />
      </div>

      {!ready && report.blockers.length > 0 && (
        <ul className="mx-4 mb-3 space-y-1 rounded-lg bg-amber-50/70 px-3 py-2
                       text-[12px] leading-5 text-amber-900">
          {report.blockers.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden>•</span><span>{b}</span>
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <div className="border-t border-black/10 px-4 py-3">
          <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-4">
            <Metric label="Coverage" value={pct(m.coverage)} />
            <Metric label="Depth" value={pct(m.depth)} />
            <Metric label="Recall accuracy" value={pct(m.recall_accuracy)} />
            <Metric label="Revision rate" value={pct(m.revision_rate)} />
          </div>

          <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide"
              style={{ color: INK.muted }}>Modules</h4>
          {report.modules.length === 0 && (
            <p className="text-xs" style={{ color: INK.secondary }}>
              No modules yet. Add one to track syllabus completion.
            </p>
          )}
          <div className="space-y-2">
            {report.modules.map((mod) => (
              <ModuleMeter key={mod.id} mod={mod} />
            ))}
          </div>

          <QuestionList subjectId={report.subject.id} subject={subject}
                        onChanged={onChanged} onOpenQuestion={onOpenQuestion} />
        </div>
      )}
    </section>
  )
}

function ReadyBadge({ ready }) {
  // status colour is never alone: icon + label always travel with it
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1
                 text-[11px] font-semibold"
      style={{
        background: ready ? '#eaf7ea' : '#fdf4e0',
        color: ready ? '#006300' : '#7a5600',
        boxShadow: `inset 0 0 0 1px ${ready ? STATUS_COLOR.good : STATUS_COLOR.warning}`,
      }}
    >
      <span aria-hidden>{ready ? '✓' : '!'}</span>
      {ready ? 'EXAM READY' : 'NOT READY'}
    </span>
  )
}

function Metric({ label, value }) {
  return (
    <div>
      <div style={{ color: INK.muted }}>{label}</div>
      <div className="text-sm font-semibold tabular-nums"
           style={{ color: INK.primary }}>{value}</div>
    </div>
  )
}

/** Stacked ordinal bar: 2px surface gaps, rounded outer ends, legend below. */
function StatusBar({ counts, total }) {
  if (!total) {
    return <div className="h-2.5 w-full rounded bg-black/5" />
  }
  const present = STATUS.filter((s) => counts[s] > 0)
  return (
    <>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded">
        {present.map((s, i) => (
          <div
            key={s}
            title={`${STATUS_LABEL[s]}: ${counts[s]}`}
            style={{
              width: `${(counts[s] / total) * 100}%`,
              background: RAMP[s],
              borderTopLeftRadius: i === 0 ? 4 : 0,
              borderBottomLeftRadius: i === 0 ? 4 : 0,
              borderTopRightRadius: i === present.length - 1 ? 4 : 0,
              borderBottomRightRadius: i === present.length - 1 ? 4 : 0,
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]"
           style={{ color: INK.secondary }}>
        {STATUS.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px]"
                  style={{ background: RAMP[s] }} aria-hidden />
            {STATUS_LABEL[s]}
            <span className="tabular-nums" style={{ color: INK.muted }}>
              {counts[s] || 0}
            </span>
          </span>
        ))}
      </div>
    </>
  )
}

function ModuleMeter({ mod }) {
  const v = mod.coverage
  return (
    <div className="flex items-center gap-3">
      <div className="w-40 shrink-0 truncate text-xs" style={{ color: INK.primary }}>
        {mod.name}
        {mod.weight !== 1 && (
          <span style={{ color: INK.muted }}> ×{mod.weight}</span>
        )}
      </div>
      <div className="relative h-2.5 flex-1 rounded bg-black/[0.06]">
        <div className="absolute inset-y-0 left-0 rounded"
             style={{ width: `${v * 100}%`, background: RAMP.revised }} />
      </div>
      <div className="w-20 shrink-0 text-right text-xs tabular-nums"
           style={{ color: INK.secondary }}>
        {pct(v)}
        <span style={{ color: INK.muted }}> · {mod.total}q</span>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- question list */

function QuestionList({ subjectId, subject, onChanged, onOpenQuestion }) {
  const [qs, setQs] = useState(null)

  const load = useCallback(() => {
    api.questions({ subject_id: subjectId }).then(setQs).catch(() => setQs([]))
  }, [subjectId])
  useEffect(() => { load() }, [load])

  const cycle = async (q) => {
    const next = STATUS[(STATUS.indexOf(q.status) + 1) % STATUS.length]
    await api.updateQuestion(q.id, { status: next })
    load(); onChanged?.()
  }

  const toggleImportant = async (q) => {
    await api.updateQuestion(q.id, { important: !q.important })
    load(); onChanged?.()
  }

  const logRecall = async (q, correct) => {
    await api.recall(q.id, correct)
    load(); onChanged?.()
  }

  const assign = async (q, moduleId) => {
    await api.updateQuestion(q.id, { module_id: moduleId || null })
    load(); onChanged?.()
  }

  if (!qs) return null
  if (!qs.length) {
    return (
      <p className="mt-4 text-xs" style={{ color: INK.secondary }}>
        No questions yet. Solve one in the notebook and save it here.
      </p>
    )
  }

  return (
    <div className="mt-5">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide"
          style={{ color: INK.muted }}>Questions</h4>
      <ul className="divide-y divide-black/5">
        {qs.map((q) => (
          <li key={q.id} className="flex flex-wrap items-center gap-2 py-2">
            <button onClick={() => toggleImportant(q)}
                    title={q.important ? 'Important' : 'Mark important'}
                    className="shrink-0 text-base leading-none"
                    style={{ color: q.important ? STATUS_COLOR.warning : '#cfcabd' }}>
              ★
            </button>
            <button onClick={() => onOpenQuestion?.(q)}
                    className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
                    style={{ color: INK.primary }}>
              {q.text}
            </button>

            <select value={q.module_id || ''}
                    onChange={(e) => assign(q, e.target.value)}
                    className="shrink-0 rounded border border-black/10 bg-white px-1
                               py-0.5 text-[11px]">
              <option value="">— module —</option>
              {(subject?.modules || []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>

            <button onClick={() => cycle(q)}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
                    style={{ background: RAMP[q.status], color: RAMP_INK[q.status] }}
                    title="Click to advance status">
              {STATUS_LABEL[q.status]}
            </button>

            <span className="shrink-0 text-[11px] tabular-nums"
                  style={{ color: INK.muted }}>
              {q.recall_total ? `${q.recall_correct}/${q.recall_total}` : '0/0'}
            </span>
            <span className="flex shrink-0 gap-1">
              <button onClick={() => logRecall(q, true)} title="Recalled correctly"
                      className="rounded border border-black/10 px-1.5 text-[11px]
                                 hover:bg-emerald-50">✓</button>
              <button onClick={() => logRecall(q, false)} title="Could not recall"
                      className="rounded border border-black/10 px-1.5 text-[11px]
                                 hover:bg-red-50">✕</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function UnfiledCard({ count, subjects, onChanged, onOpenQuestion }) {
  const [qs, setQs] = useState([])
  useEffect(() => {
    api.questions().then((all) => setQs(all.filter((q) => !q.subject_id)))
      .catch(() => setQs([]))
  }, [count])

  const file = async (q, subjectId) => {
    await api.updateQuestion(q.id, { subject_id: subjectId })
    setQs((prev) => prev.filter((x) => x.id !== q.id))
    onChanged?.()
  }

  if (!qs.length) return null
  return (
    <section className="mt-4 rounded-xl border border-black/10 bg-[#fbf9f3] px-4 py-3">
      <h3 className="mb-2 text-sm font-semibold">
        Unfiled questions <span style={{ color: INK.muted }}>({qs.length})</span>
      </h3>
      <ul className="divide-y divide-black/5">
        {qs.map((q) => (
          <li key={q.id} className="flex items-center gap-2 py-2">
            <button onClick={() => onOpenQuestion?.(q)}
                    className="min-w-0 flex-1 truncate text-left text-xs hover:underline">
              {q.text}
            </button>
            <select defaultValue="" onChange={(e) => e.target.value && file(q, e.target.value)}
                    className="rounded border border-black/10 bg-white px-1 py-0.5 text-[11px]">
              <option value="">file under…</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </section>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="mt-6 rounded-xl border border-dashed border-black/15 px-6 py-10 text-center">
      <p className="hand text-2xl" style={{ color: INK.secondary }}>
        No subjects yet.
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: INK.secondary }}>
        Add a subject, break it into modules, then solve questions in the notebook
        and save them here. EXAM READY appears only once coverage, important
        questions and recall all clear their thresholds.
      </p>
      <button onClick={onAdd}
              className="mt-4 rounded-lg bg-ink px-3 py-2 text-sm text-white">
        Add your first subject
      </button>
    </div>
  )
}
