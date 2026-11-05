import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import AnswerSheet, { RichText } from './AnswerSheet'
import { MarginNote, threadsFromRows } from './StepTools'

const OUTCOME = {
  knew: ['Knew it', 'bg-emerald-50 text-emerald-800 ring-emerald-200'],
  hint: ['Needed a hint', 'bg-amber-50 text-amber-900 ring-amber-200'],
  answer: ['Needed the answer', 'bg-red-50 text-red-800 ring-red-200'],
}

/**
 * A module's reference notes: each question, the student's own handwritten
 * attempt, the hint, the worked answer and every annotation, in order.
 *
 * Used in the app (with share/export controls) and, read-only, on the page a
 * friend opens from a share link. Prints cleanly to PDF.
 */
export default function NotesView({ query, data: given, readOnly, onBack, shareToken }) {
  const [data, setData] = useState(given || null)
  const [err, setErr] = useState(null)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (given) { setData(given); return }
    api.notes(query).then(setData).catch((e) => setErr(e.message))
  }, [given, query?.module_id, query?.subject_id])   // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="m-6 rounded-lg bg-red-50 p-4 text-sm text-red-700">{err}</div>
  if (!data) return <div className="p-10 text-center text-sm text-ink-soft">Loading…</div>

  let n = 0
  const title = data.share?.title || (data.modules.length === 1
    ? data.modules[0].name : data.subject.name)
  const exportQuery = query?.module_id ? { module_id: query.module_id }
    : { subject_id: data.subject.id }

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-[#eceadf] py-5 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex flex-wrap items-center gap-2 px-2"
           style={{ width: 'min(94%, 880px)' }}>
        {onBack && (
          <button onClick={onBack} className="text-sm text-ink-soft hover:text-ink">← Back</button>
        )}
        <span className="text-xs text-ink-soft">
          {data.counts.questions} questions · {data.counts.attempted} attempted ·{' '}
          {data.counts.answered} worked answers
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => window.print()}
                  className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-sm">
            Print / PDF
          </button>
          {readOnly && shareToken && (
            <a href={`/api/share/${shareToken}/bundle`}
               className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white">
              Download to my INKWISE
            </a>
          )}
          {!readOnly && (
            <>
              <a href={api.exportUrl(exportQuery)}
                 className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-sm">
                Export file
              </a>
              <button onClick={() => setSharing(true)}
                      className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white">
                Share with friends
              </button>
            </>
          )}
        </div>
      </div>

      <article className="ruled mx-auto rounded-sm px-0 shadow-[0_2px_24px_rgba(28,25,18,0.13)]
                          ring-1 ring-paper-edge print:shadow-none print:ring-0"
               style={{ width: 'min(94%, 880px)' }}>
        <div className="border-l-2 border-margin/70 pb-8" style={{ marginLeft: '8%' }}>
          <header className="px-6 pb-2 pt-5">
            <h1 className="hand text-[2.1rem] leading-9">{title}</h1>
            <p className="text-xs text-ink-soft">
              {data.subject.name}
              {data.subject.origin ? ` · ${data.subject.origin}` : ''}
            </p>
          </header>

          {data.modules.map((m) => (
            <section key={m.id} className="px-6">
              {data.modules.length > 1 && (
                <h2 className="hand mt-4 border-b border-rule text-[1.7rem] text-accent">{m.name}</h2>
              )}
              {m.questions.length === 0 && (
                <p className="py-3 text-sm text-ink-soft">No questions in this module.</p>
              )}
              {m.questions.map((q) => {
                n += 1
                return <QuestionNote key={q.id} n={n} q={q} />
              })}
            </section>
          ))}
        </div>
      </article>

      {sharing && (
        <ShareDialog target={query?.module_id ? { module_id: query.module_id }
                       : { subject_id: data.subject.id }}
                     exportHref={api.exportUrl(exportQuery)}
                     onClose={() => setSharing(false)} />
      )}
    </div>
  )
}

function QuestionNote({ n, q }) {
  const a = q.attempt
  const notesByStep = threadsFromRows(q.explanations)
  const outcome = a?.outcome && OUTCOME[a.outcome]

  return (
    <div className="break-inside-avoid border-b border-dashed border-rule py-4 last:border-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="hand text-[1.35rem] text-accent">Q{n}.</span>
        {q.marks && <span className="text-[11px] text-ink-soft">[{q.marks} marks]</span>}
        {q.important && <span className="text-[11px]" style={{ color: '#b07800' }}>★ important</span>}
        {outcome ? (
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] ring-1 ${outcome[1]}`}>
            {outcome[0]}
          </span>
        ) : (
          <span className="ml-auto text-[11px] text-ink-soft/60">not attempted yet</span>
        )}
      </div>
      <RichText text={q.text} className="hand block text-[1.45rem] leading-8 text-ink" />

      {a?.image && (
        <figure className="mt-3">
          <figcaption className="hand text-[1.15rem] text-ink-soft">My answer</figcaption>
          {/* the PNG has a white background; multiply lets the paper show through */}
          <img src={a.image} alt="handwritten answer"
               className="mt-1 max-h-[420px] max-w-full mix-blend-multiply" />
        </figure>
      )}

      {a?.hint_steps?.length > 0 && (
        <div className="mt-3 rounded-lg border-l-4 border-amber-400 bg-amber-50/60 px-4 py-2">
          <AnswerSheet steps={a.hint_steps} instant dense />
        </div>
      )}

      {q.answer_steps?.length > 0 && (
        <div className="mt-3">
          <div className="hand text-[1.3rem] text-emerald-800">Worked answer</div>
          <AnswerSheet steps={q.answer_steps} instant dense
                       afterStep={(s) => (notesByStep[s.index]
                         ? <MarginNote index={s.index} turns={notesByStep[s.index]} /> : null)} />
        </div>
      )}
    </div>
  )
}

function ShareDialog({ target, exportHref, onClose }) {
  const [share, setShare] = useState(null)
  const [err, setErr] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.share(target).then(setShare).catch((e) => setErr(e.message))
  }, [target.module_id, target.subject_id])   // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async () => {
    if (!share) return
    await api.revokeShare(share.token)
    onClose()
  }

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Share these notes</h2>
            <p className="text-sm text-ink-soft">
              Friends on the same Wi-Fi can open the link or scan the code. It is
              read-only, and you can turn it off at any time.
            </p>
          </div>
          <button onClick={onClose}
                  className="rounded px-2 text-xl leading-none text-ink-soft hover:bg-slate-100">×</button>
        </div>

        {err && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        {!share && !err && <div className="py-12 text-center text-sm text-ink-soft">Creating link…</div>}

        {share && (
          <>
            <div className="flex justify-center rounded-lg border border-slate-200 p-3">
              <div className="h-48 w-48 [&>svg]:h-full [&>svg]:w-full"
                   dangerouslySetInnerHTML={{ __html: share.svg }} />
            </div>
            <div className="mt-3 flex gap-2">
              <input readOnly value={share.url}
                     className="flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5
                                font-mono text-[12px]" />
              <button onClick={() => {
                        navigator.clipboard?.writeText(share.url)
                        setCopied(true)
                      }}
                      className="rounded border border-slate-200 px-3 text-sm">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-4 text-xs text-ink-soft">
              Not on the same network? Send the file instead — they open it from
              <em> Question bank → Open a friend's notes</em>.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <a href={exportHref} className="rounded-lg bg-ink px-3 py-2 text-sm text-white">
                Download notes file
              </a>
              <button onClick={revoke} className="ml-auto text-xs text-red-700 hover:underline">
                turn off this link
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The page a friend lands on from a share link: /notes/<token>. */
export function SharedNotes({ token }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    api.openShare(token).then(setData).catch((e) => setErr(e.message))
  }, [token])
  if (err) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="hand text-3xl">INKWISE</p>
          <p className="mt-2 text-sm text-ink-soft">{err}</p>
        </div>
      </div>
    )
  }
  if (!data) return <div className="p-10 text-center text-sm text-ink-soft">Loading…</div>
  return <NotesView data={data} readOnly shareToken={token} />
}
