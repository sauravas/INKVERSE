import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

const ACCEPT = '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff'
const KINDS = [
  ['auto', 'Detect automatically'], ['questions', 'Question bank / paper'],
  ['syllabus', 'Syllabus'], ['notes', 'Notes / reference material'],
]
const METHOD_LABEL = { text: 'text layer', ocr: 'OCR (Tesseract)', mixed: 'text + OCR' }

/**
 * Import a document, review what was understood, then save.
 * Nothing is written until the student has seen and corrected the proposal -
 * OCR and heuristic parsing are useful, not trustworthy.
 */
export default function ImportView({ onPractise }) {
  const [ocr, setOcr] = useState(null)
  const [kind, setKind] = useState('auto')
  const [phase, setPhase] = useState('idle')      // idle|reading|preview|saving|done
  const [err, setErr] = useState(null)
  const [preview, setPreview] = useState(null)
  const [drafts, setDrafts] = useState([])
  const [subjects, setSubjects] = useState([])
  const [subjectId, setSubjectId] = useState('new')
  const [subjectName, setSubjectName] = useState('')
  const [result, setResult] = useState(null)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    api.importStatus().then((s) => setOcr(s.ocr)).catch(() => setOcr(null))
    api.subjects().then(setSubjects).catch(() => {})
  }, [])

  const read = async (file) => {
    if (!file) return
    setErr(null); setPhase('reading'); setResult(null)
    try {
      const p = await api.importExtract(file, kind)
      setPreview(p)
      setDrafts(p.modules.map((m) => ({
        name: m.name, notes: m.notes || '', showNotes: false,
        questions: m.questions.map((q) => ({ ...q, important: false })),
      })))
      setSubjectName(p.filename?.replace(/\.[^.]+$/, '') || '')
      setPhase('preview')
    } catch (e) {
      setErr(e.message); setPhase('idle')
    }
  }

  const edit = (mi, fn) => setDrafts((d) => d.map((m, i) => (i === mi ? fn({ ...m }) : m)))
  const editQ = (mi, qi, fields) => edit(mi, (m) => ({
    ...m, questions: m.questions.map((q, j) => (j === qi ? { ...q, ...fields } : q)),
  }))

  const save = async () => {
    setErr(null); setPhase('saving')
    try {
      const r = await api.importCommit({
        subject_id: subjectId === 'new' ? null : subjectId,
        subject_name: subjectId === 'new' ? subjectName : null,
        filename: preview.filename, kind: preview.kind, method: preview.method,
        pages: preview.pages, text: preview.text,
        modules: drafts.filter((m) => m.name.trim()).map((m) => ({
          name: m.name.trim(),
          notes: m.notes,
          questions: m.questions.filter((q) => q.text.trim()),
        })),
      })
      setResult(r); setPhase('done')
    } catch (e) {
      setErr(e.message); setPhase('preview')
    }
  }

  const reset = () => {
    setPhase('idle'); setPreview(null); setDrafts([]); setResult(null); setErr(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const qTotal = drafts.reduce((n, m) => n + m.questions.filter((q) => q.text.trim()).length, 0)

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-[#f4f2ea] px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4">
          <h1 className="text-xl font-semibold">Import</h1>
          <p className="text-sm text-ink-soft">
            Bring in a question bank, past paper, syllabus or notes. Questions go into
            the question bank; everything is indexed so answers can be grounded in it.
          </p>
        </header>

        {err && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</div>}

        {(phase === 'idle' || phase === 'reading') && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragging(false)
              if (phase === 'idle') read(e.dataTransfer.files?.[0])
            }}
            className={`rounded-xl border-2 border-dashed px-6 py-10 text-center transition
              ${dragging ? 'border-accent bg-blue-50' : 'border-black/15 bg-[#fbf9f3]'}`}
          >
            {phase === 'reading' ? (
              <div className="flex flex-col items-center gap-3 text-sm text-ink-soft">
                <span className="h-6 w-6 animate-spin rounded-full border-2
                                 border-ink-soft/30 border-t-ink-soft" />
                Reading the document… scanned pages go through OCR and take a few
                seconds each.
              </div>
            ) : (
              <>
                <p className="hand text-2xl text-ink-soft">Drop a file here</p>
                <p className="mt-1 text-xs text-ink-soft">
                  PDF, DOCX, TXT or a photo/scan of a printed page
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <select value={kind} onChange={(e) => setKind(e.target.value)}
                          className="rounded-lg border border-black/15 bg-white px-2 py-2 text-sm">
                    {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <button onClick={() => fileRef.current?.click()}
                          className="rounded-lg bg-ink px-4 py-2 text-sm text-white">
                    Choose file
                  </button>
                  <input ref={fileRef} type="file" accept={ACCEPT} className="hidden"
                         onChange={(e) => read(e.target.files?.[0])} />
                </div>
                <OcrLine ocr={ocr} />
              </>
            )}
          </div>
        )}

        {(phase === 'preview' || phase === 'saving') && preview && (
          <>
            <div className="mb-3 rounded-xl border border-black/10 bg-[#fbf9f3] px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-medium">{preview.filename}</span>
                <span className="text-ink-soft">
                  read via {METHOD_LABEL[preview.method] || preview.method}
                </span>
                <span className="text-ink-soft">
                  {preview.pages} page{preview.pages === 1 ? '' : 's'}
                </span>
                <span className="text-ink-soft">detected as {preview.kind}</span>
                <button onClick={reset} className="ml-auto text-xs text-ink-soft hover:underline">
                  choose another file
                </button>
              </div>
              {preview.truncated && (
                <p className="mt-2 text-xs text-amber-800">
                  Only the first {preview.pages} of {preview.total_pages} pages were read.
                </p>
              )}
              {preview.method !== 'text' && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                  OCR loses superscripts and some symbols — <code>x²</code> can come out
                  as <code>x2</code>. Check the numbers in each question below before
                  saving; you can write maths as <code>$x^2$</code>.
                </p>
              )}
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-soft">Save into</span>
              <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}
                      className="rounded-lg border border-black/15 bg-white px-2 py-1.5">
                <option value="new">a new subject…</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {subjectId === 'new' && (
                <input value={subjectName} onChange={(e) => setSubjectName(e.target.value)}
                       placeholder="Subject name"
                       className="min-w-[16rem] flex-1 rounded-lg border border-black/15 px-3 py-1.5" />
              )}
            </div>

            {drafts.length === 0 && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                No modules or questions were recognised. Try a different document type
                in the selector, or check the extracted text below.
              </p>
            )}

            <div className="space-y-3">
              {drafts.map((m, mi) => (
                <section key={mi} className="rounded-xl border border-black/10 bg-[#fbf9f3]">
                  <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2">
                    <input value={m.name} onChange={(e) => edit(mi, (x) => ({ ...x, name: e.target.value }))}
                           className="flex-1 rounded border border-transparent bg-transparent px-1
                                      py-0.5 font-semibold hover:border-black/10 focus:border-black/20" />
                    <span className="text-xs text-ink-soft">
                      {m.questions.length} question{m.questions.length === 1 ? '' : 's'}
                    </span>
                    <button onClick={() => setDrafts((d) => d.filter((_, i) => i !== mi))}
                            className="text-xs text-red-700 hover:underline">remove module</button>
                  </div>

                  <ol className="divide-y divide-black/5">
                    {m.questions.map((q, qi) => (
                      <li key={qi} className="flex items-start gap-2 px-4 py-2">
                        <span className="mt-1.5 w-6 shrink-0 text-right text-xs text-ink-soft">
                          {qi + 1}.
                        </span>
                        <textarea value={q.text} rows={Math.min(5, 1 + Math.floor(q.text.length / 90))}
                                  onChange={(e) => editQ(mi, qi, { text: e.target.value })}
                                  className="flex-1 resize-y rounded border border-black/10 bg-white
                                             px-2 py-1 text-sm leading-5" />
                        <input value={q.marks || ''} placeholder="marks"
                               onChange={(e) => editQ(mi, qi, { marks: e.target.value || null })}
                               className="w-14 shrink-0 rounded border border-black/10 bg-white px-1
                                          py-1 text-center text-xs" />
                        <button onClick={() => editQ(mi, qi, { important: !q.important })}
                                title="Important"
                                className="mt-0.5 shrink-0 text-lg leading-none"
                                style={{ color: q.important ? '#fab219' : '#cfcabd' }}>★</button>
                        <button onClick={() => edit(mi, (x) => ({
                                  ...x, questions: x.questions.filter((_, j) => j !== qi) }))}
                                title="Remove"
                                className="mt-0.5 shrink-0 px-1 text-ink-soft hover:text-red-700">×</button>
                      </li>
                    ))}
                  </ol>
                  <div className="flex items-center gap-3 px-4 py-2 text-xs">
                    <button onClick={() => edit(mi, (x) => ({
                              ...x, questions: [...x.questions, { text: '', marks: null, important: false }] }))}
                            className="text-accent hover:underline">+ add question</button>
                    {m.notes && (
                      <button onClick={() => edit(mi, (x) => ({ ...x, showNotes: !x.showNotes }))}
                              className="text-ink-soft hover:underline">
                        {m.showNotes ? 'hide' : 'show'} reference text ({m.notes.length} chars)
                      </button>
                    )}
                  </div>
                  {m.showNotes && (
                    <div className="px-4 pb-3">
                      <textarea value={m.notes} rows={6}
                                onChange={(e) => edit(mi, (x) => ({ ...x, notes: e.target.value }))}
                                className="w-full rounded border border-black/10 bg-white px-2 py-1
                                           font-mono text-xs leading-5" />
                    </div>
                  )}
                </section>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-3">
              <button onClick={() => setDrafts((d) => [...d, {
                        name: `Module ${d.length + 1}`, notes: '', questions: [], showNotes: false }])}
                      className="text-sm text-accent hover:underline">+ add module</button>
              <details className="text-xs text-ink-soft">
                <summary className="cursor-pointer">extracted text</summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white
                                p-2 text-[11px]">{preview.text}</pre>
              </details>
            </div>

            <div className="sticky bottom-0 mt-4 flex items-center gap-3 border-t border-black/10
                            bg-[#f4f2ea] py-3">
              <button onClick={save}
                      disabled={phase === 'saving' || !drafts.length
                                || (subjectId === 'new' && !subjectName.trim())}
                      className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-40">
                {phase === 'saving' ? 'Saving…'
                  : `Import ${qTotal} question${qTotal === 1 ? '' : 's'} into `
                    + `${drafts.length} module${drafts.length === 1 ? '' : 's'}`}
              </button>
              <button onClick={reset} className="text-sm text-ink-soft hover:underline">cancel</button>
            </div>
          </>
        )}

        {phase === 'done' && result && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
            <p className="font-medium text-emerald-900">Imported.</p>
            <p className="mt-1 text-sm text-emerald-900/80">
              {result.questions_created} new question{result.questions_created === 1 ? '' : 's'},{' '}
              {result.modules_created} new module{result.modules_created === 1 ? '' : 's'},{' '}
              {result.chunks_indexed} passage{result.chunks_indexed === 1 ? '' : 's'} indexed for
              grounding.
              {result.questions_created === 0 && result.chunks_indexed === 0
                && ' This document was already imported, so nothing was duplicated.'}
            </p>
            <div className="mt-3 flex gap-2">
              <button onClick={onPractise}
                      className="rounded-lg bg-ink px-3 py-2 text-sm text-white">
                Go to the question bank
              </button>
              <button onClick={reset}
                      className="rounded-lg border border-black/15 px-3 py-2 text-sm">
                Import another
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function OcrLine({ ocr }) {
  if (!ocr) return null
  return (
    <p className={`mt-4 text-[11px] ${ocr.available ? 'text-ink-soft' : 'text-amber-800'}`}>
      {ocr.available
        ? `Scans are read with ${ocr.version} (${(ocr.languages || [])
            .filter((l) => l !== 'osd').join(', ')})`
        : ocr.detail}
    </p>
  )
}
