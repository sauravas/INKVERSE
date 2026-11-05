import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, streamSteps } from '../lib/api'
import { isLoop, resolveCircle } from '../lib/circle'
import { canHighlight, findQuote, paint } from '../lib/highlight'
import { useLibraryVersion } from '../lib/library'
import { canSpeak, speak, speakableStep } from '../lib/speak'
import AnswerSheet, { stepToText, stepsToText } from './AnswerSheet'
import LinedInput from './LinedInput'
import MicButton from './MicButton'
import Snap from './Snap'
import { MarginNote, SourcesNote } from './StepTools'

/**
 * Prepared study notes, one set per module, to read, mark up and question.
 *
 * Each topic is a row: the handwritten section on ruled paper, and beside it
 * a margin where explanations of that section appear. Select words to
 * highlight or ask about them; switch to the pen to write on the notes - a
 * loop drawn round something asks about it. Everything is kept.
 */
export default function NotesStudy({ ai }) {
  const [modules, setModules] = useState(null)
  const [moduleId, setModuleId] = useState(null)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [writing, setWriting] = useState(null)        // {steps, streaming, sources}

  const loadModules = useCallback(() => {
    api.noteModules().then((m) => {
      setModules(m)
      setModuleId((cur) => cur || m[0]?.modules[0]?.id || null)
    }).catch((e) => setErr(e.message))
  }, [])
  // newly imported material becomes a module with passages to write notes
  // from, so the list has to follow the library rather than the mount
  const libraryVersion = useLibraryVersion()
  useEffect(() => { loadModules() }, [loadModules, libraryVersion])

  const load = useCallback((mid) => {
    if (!mid) return
    setData(null)
    api.studyNotes(mid).then(setData).catch((e) => setErr(e.message))
  }, [])
  useEffect(() => { setWriting(null); load(moduleId) },
            [moduleId, load, libraryVersion])

  const prepare = () => {
    if (data?.note && !window.confirm('Write these notes again? Your highlights, ink and '
      + 'questions stay attached to the section numbers they were on.')) return
    let latest = []
    setWriting({ steps: [], streaming: true })
    streamSteps(`/api/study-notes/${moduleId}/prepare`,
      { provider: ai.provider, consent_cloud: !!ai.consent }, {
        onSteps: (st) => { latest = st; setWriting((w) => ({ ...w, steps: st })) },
        onSources: (items) => setWriting((w) => ({ ...w, sources: items })),
        onNotice: (n) => setWriting((w) => ({ ...w, notices: [...(w.notices || []), n] })),
        onDone: () => {
          setWriting((w) => ({ ...w, streaming: false }))
          // let the pen finish before swapping to the annotatable layout
          setTimeout(() => { setWriting(null); load(moduleId); loadModules() },
            latest.length ? 2500 : 0)
        },
        onError: (e) => { setErr(e.message); setWriting(null) },
      })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="scroll-thin w-64 shrink-0 overflow-y-auto border-r border-black/10 bg-[#fbf9f3]">
        <div className="px-4 py-3">
          <h1 className="hand text-2xl">Notes</h1>
          <p className="text-[11px] text-ink-soft">Prepared from your syllabus and question bank.</p>
        </div>
        {modules?.length === 0 && (
          <p className="px-4 text-xs text-ink-soft">
            No modules yet. Import a syllabus or question bank first.
          </p>
        )}
        {modules?.map((s) => (
          <div key={s.id} className="mb-2">
            <div className="truncate px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
              {s.name}
            </div>
            {s.modules.map((m) => (
              <button key={m.id} onClick={() => setModuleId(m.id)}
                      className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
                        m.id === moduleId ? 'bg-ink text-white' : 'hover:bg-black/5'}`}>
                <span className={m.note_id ? 'text-emerald-500' : 'text-ink-soft/40'}>
                  {m.note_id ? '●' : '○'}
                </span>
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[#eceadf] py-5">
        {err && <div className="mx-auto mb-3 max-w-4xl rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</div>}
        {!data && !err && moduleId && <div className="p-10 text-center text-sm text-ink-soft">Loading…</div>}
        {data && (
          <div className="mx-auto" style={{ width: 'min(96%, 1180px)' }}>
            <header className="mb-3 flex flex-wrap items-center gap-3 px-1">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-soft">{data.subject.name}</div>
                <h2 className="hand text-3xl leading-8">{data.module.name}</h2>
              </div>
              <div className="ml-auto flex gap-2">
                {!writing && (
                  <button onClick={prepare}
                          className={`rounded-lg px-3 py-1.5 text-sm ${data.note
                            ? 'border border-black/15 bg-white' : 'bg-accent text-white'}`}>
                    {data.note ? 'Write again' : 'Prepare notes'}
                  </button>
                )}
              </div>
            </header>

            {writing && (
              <article className="ruled rounded-sm px-8 py-[var(--rule)] shadow ring-1 ring-paper-edge">
                <SourcesNote items={writing.sources} notices={writing.notices} />
                <AnswerSheet steps={writing.steps} streaming={writing.streaming} notes
                             emptyHint="Reading your syllabus and writing the notes…" />
              </article>
            )}

            {!writing && !data.note && (
              <div className="rounded-xl border border-dashed border-black/15 bg-[#fbf9f3] px-6 py-10 text-center">
                <p className="hand text-2xl text-ink-soft">No notes for this module yet.</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
                  INKWISE writes them from {data.imported.text
                    ? 'your imported syllabus and questions' : 'the module name and its questions'},
                  with diagrams and tables where they help. You can then highlight,
                  write on them, and ask about any part.
                </p>
                <button onClick={prepare} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-white">
                  Prepare notes
                </button>
              </div>
            )}

            {!writing && data.note && (
              <Sheet key={data.note.id} data={data} ai={ai} />
            )}

            {data.imported.text && (
              <details className="mt-4 rounded-xl bg-[#fbf9f3] px-5 py-3 ring-1 ring-black/10">
                <summary className="cursor-pointer text-sm font-medium">
                  From your imported material
                  <span className="ml-2 text-xs font-normal text-ink-soft">
                    {data.imported.headings.join(' · ')}
                  </span>
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-6 text-ink-soft">
                  {data.imported.text}
                </pre>
              </details>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

/* -------------------------------------------------------- the marked-up sheet */

function Sheet({ data, ai }) {
  const sections = data.note.steps
  const noteId = data.note.id
  const sheetRef = useRef(null)
  const [marks, setMarks] = useState(data.marks)
  const [pen, setPen] = useState(false)
  const [tip, setTip] = useState(null)                  // selection toolbar
  const [asking, setAsking] = useState(null)            // {i, quote}
  const [askText, setAskText] = useState('')
  const [threads, setThreads] = useState(() => {
    const t = {}
    let id = -1
    for (const m of data.marks) {
      if (m.kind !== 'question') continue
      ;(t[m.section_index] ||= []).push({ id: id--, markId: m.id, ask: m.ask, about: m.quote,
                                          steps: m.data || [], instant: true })
    }
    return t
  })
  const latest = useRef(threads)
  latest.current = threads
  const nextId = useRef(0)
  const notesText = useMemo(() => stepsToText(sections).slice(0, 6000), [sections])

  // --- highlights: re-found in the rendered text after every render ------
  useLayoutEffect(() => {
    if (!canHighlight() || !sheetRef.current) return undefined
    const draw = () => paint('ink-highlight', marks.filter((m) => m.kind === 'highlight')
      .map((m) => findQuote(sheetRef.current?.querySelector(`[data-section="${m.section_index}"]`), m.quote)))
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(sheetRef.current)
    return () => { ro.disconnect(); paint('ink-highlight', []) }
  }, [marks])

  // --- asking about a passage ---------------------------------------------
  const patchTurn = (i, id, fields) => setThreads((t) => ({
    ...t, [i]: (t[i] || []).map((x) => (x.id === id ? { ...x, ...fields } : x)) }))

  const send = (i, ask, { about = '', label, voice } = {}) => {
    const text = (ask || '').trim()
    if (!text) return
    const id = ++nextId.current
    const history = (latest.current[i] || []).filter((x) => x.steps?.length)
      .map((x) => ({ ask: x.ask, answer: stepsToText(x.steps) }))
    setThreads((t) => ({ ...t, [i]: [...(t[i] || []),
      { id, ask: label || text, about, steps: [], streaming: true }] }))
    let built = []
    streamSteps('/api/ai/explain', {
      question: `Study notes: ${data.module.name} (${data.subject.name})`,
      answer: notesText, step: stepToText(sections[i]), step_index: i,
      ask: text, focus: about, history, provider: ai.provider, consent_cloud: !!ai.consent,
    }, {
      onSteps: (st) => { built = st; patchTurn(i, id, { steps: st }) },
      onNotice: (n) => patchTurn(i, id, { notice: n }),
      onDone: async () => {
        patchTurn(i, id, { streaming: false })
        if (voice && canSpeak()) speak(built.map(speakableStep))
        // keep the question and its explanation with the notes
        try {
          const r = await api.addMark(noteId, { section_index: i, kind: 'question',
            quote: about, ask: label || text, data: built })
          patchTurn(i, id, { markId: r.id })
        } catch { /* the explanation is still on screen */ }
      },
      onError: (e) => patchTurn(i, id, { streaming: false, error: e.message }),
    })
  }

  // --- selecting words -----------------------------------------------------
  const onSelect = (i, e) => {
    if (pen) return
    const sel = window.getSelection()
    const quote = sel?.toString().replace(/\s+/g, ' ').trim()
    if (!quote || quote.length < 2) { setTip(null); return }
    const cell = e.currentTarget
    if (!cell.contains(sel.anchorNode)) return
    const r = sel.getRangeAt(0).getBoundingClientRect()
    const existing = marks.find((m) => m.kind === 'highlight' && m.section_index === i
      && (m.quote.includes(quote) || quote.includes(m.quote)))
    setTip({ i, quote, x: r.left + r.width / 2, y: r.top, existing })
  }
  const highlight = async () => {
    const { i, quote } = tip
    setTip(null); window.getSelection()?.removeAllRanges()
    const r = await api.addMark(noteId, { section_index: i, kind: 'highlight', quote })
    setMarks((m) => [...m, { id: r.id, section_index: i, kind: 'highlight', quote }])
  }
  const unhighlight = async () => {
    const id = tip.existing.id
    setTip(null)
    await api.deleteMark(id)
    setMarks((m) => m.filter((x) => x.id !== id))
  }

  // --- pen on the notes ---------------------------------------------------
  const inkOf = (i) => marks.find((m) => m.kind === 'ink' && m.section_index === i)
  const saveInk = async (i, strokes) => {
    const cur = inkOf(i)
    if (cur) {
      setMarks((m) => m.map((x) => (x.id === cur.id ? { ...x, data: strokes } : x)))
      await api.updateMark(cur.id, strokes)
    } else {
      const r = await api.addMark(noteId, { section_index: i, kind: 'ink', data: strokes })
      setMarks((m) => [...m, { id: r.id, section_index: i, kind: 'ink', data: strokes }])
    }
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-2 px-1 text-xs text-ink-soft">
        <button onClick={() => { setPen(!pen); setTip(null) }}
                className={`rounded-full px-3 leading-7 ring-1 ${pen
                  ? 'bg-ink text-white ring-ink' : 'bg-white ring-black/15 hover:bg-black/5'}`}>
          {pen ? '✎ Writing on the notes' : '✎ Write on the notes'}
        </button>
        <span>
          {pen ? 'Write anywhere. Draw a loop round something to ask about it.'
            : 'Select words to highlight them or ask about them.'}
        </span>
      </div>

      <div ref={sheetRef}
           className="grid overflow-hidden rounded-sm shadow ring-1 ring-paper-edge"
           style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 36%)' }}>
        {sections.map((sec, i) => (
          <Fragment key={i}>
            <div data-section={i} className="ruled relative" onMouseUp={(e) => onSelect(i, e)}>
              <div className="ml-[7%] border-l-2 border-margin/70 pl-4 pr-5">
                <AnswerSheet steps={[sec]} instant notes
                             onAskBlock={(step, label) => send(i,
                               `Explain the "${label}" block in this diagram.`, { about: `the block "${label}"` })} />
              </div>
              <InkLayer active={pen} strokes={inkOf(i)?.data || []}
                        onStrokes={(s) => saveInk(i, s)}
                        onLoop={(poly, cell) => {
                          const hit = resolveCircle(cell, poly)
                          if (hit) { setAsking({ i, quote: hit.focus }); setAskText('') }
                        }} />
            </div>
            <div className="border-l border-black/5 bg-[#f7f4ec] px-3">
              <Snap>
                {(threads[i] || []).length > 0 && (
                  <MarginNote index={i + 1} turns={threads[i]}
                              heading="Your questions on this"
                              onFollowUp={(text, voice, label) => send(i, text, { voice, label })} />
                )}
                {asking?.i === i && (
                  <div className="rounded-lg bg-amber-50/80 px-3 ring-1 ring-amber-300">
                    <p className="lined-row truncate text-xs text-orange-800">about: {asking.quote}</p>
                    <LinedInput value={askText} onChange={setAskText} size="small" autoFocus
                                placeholder="what do you want to know?"
                                onSubmit={() => { send(i, askText, { about: asking.quote }); setAsking(null) }}>
                      <MicButton size="sm" onText={(c, p) => setAskText(`${c}${p ? ` ${p}` : ''}`)}
                                 onDone={(t) => { send(i, t, { about: asking.quote, voice: true }); setAsking(null) }} />
                      <button onClick={() => setAsking(null)} className="px-1 text-xs text-ink-soft">✕</button>
                    </LinedInput>
                  </div>
                )}
                {!(threads[i] || []).length && asking?.i !== i && (
                  <button onClick={() => { setAsking({ i, quote: sec.title || `section ${i + 1}` }); setAskText('') }}
                          className="lined-row block text-left text-[11px] text-ink-soft/60 hover:text-ink">
                    + ask about this section
                  </button>
                )}
              </Snap>
            </div>
          </Fragment>
        ))}
      </div>

      {tip && (
        <div className="fixed z-50 flex -translate-x-1/2 -translate-y-full gap-1 rounded-lg bg-ink p-1 text-xs text-white shadow-lg"
             style={{ left: tip.x, top: tip.y - 8 }}
             onMouseDown={(e) => e.preventDefault()}>
          {tip.existing
            ? <button onClick={unhighlight} className="rounded px-2 py-1 hover:bg-white/15">Remove highlight</button>
            : <button onClick={highlight} className="rounded px-2 py-1 hover:bg-white/15">Highlight</button>}
          <button onClick={() => { send(tip.i, `Explain "${tip.quote}" from these notes.`, { about: tip.quote, label: 'Explain this' }); setTip(null) }}
                  className="rounded px-2 py-1 hover:bg-white/15">Explain</button>
          <button onClick={() => { setAsking({ i: tip.i, quote: tip.quote }); setAskText(''); setTip(null) }}
                  className="rounded px-2 py-1 hover:bg-white/15">Ask…</button>
        </div>
      )}
    </>
  )
}

/**
 * Pen ink on one section of the notes. Strokes are stored relative to the
 * section's width, so they stay on the words they were written on when the
 * window is resized. A loop also asks about what it encloses.
 */
function InkLayer({ active, strokes, onStrokes, onLoop }) {
  const ref = useRef(null)
  const [w, setW] = useState(1)
  const [live, setLive] = useState(null)
  const pts = useRef([])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setW(el.clientWidth || 1))
    ro.observe(el)
    setW(el.clientWidth || 1)
    return () => ro.disconnect()
  }, [])

  const local = (e) => {
    const r = ref.current.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width]
  }
  const up = () => {
    const p = pts.current
    pts.current = []
    setLive(null)
    if (p.length < 2) return
    onStrokes([...strokes, p.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])])
    const r = ref.current.getBoundingClientRect()
    const px = p.map(([x, y]) => [x * r.width, y * r.width])
    if (isLoop(px)) onLoop(px.map(([x, y]) => [x + r.left, y + r.top]), ref.current.parentElement)
  }
  const d = (s) => `M${s.map(([x, y]) => `${(x * w).toFixed(1)},${(y * w).toFixed(1)}`).join(' L')}`

  return (
    <svg ref={ref}
         className={`absolute inset-0 h-full w-full ${active ? 'ink-surface z-10' : 'pointer-events-none'}`}
         onPointerDown={(e) => {
           if (!active) return
           e.currentTarget.setPointerCapture?.(e.pointerId)
           pts.current = [local(e)]
           setLive(pts.current)
         }}
         onPointerMove={(e) => {
           if (!active || !pts.current.length) return
           const evs = e.nativeEvent.getCoalescedEvents?.()
           for (const ev of (evs && evs.length ? evs : [e.nativeEvent])) pts.current.push(local(ev))
           setLive([...pts.current])
         }}
         onPointerUp={up} onPointerCancel={up}>
      {[...strokes, ...(live ? [live] : [])].map((s, k) => (
        <path key={k} d={d(s)} fill="none" stroke="#b91c1c" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
      ))}
    </svg>
  )
}
