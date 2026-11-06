import { useCallback, useEffect, useRef, useState } from 'react'
import AnswerSheet from './components/AnswerSheet'
import InkCanvas from './components/InkCanvas'
import LinedInput from './components/LinedInput'
import { api, streamSteps } from './lib/api'
import { useSharedAnswer } from './lib/shared-answer'
import { PEN_COLORS } from './lib/ink'
import { useWorkspace } from './lib/sync'

/**
 * Phone writing pad.
 *
 * The same InkCanvas as the laptop, on the same workspace, so an S Pen stroke
 * lands on the laptop page as it is drawn. Palm rejection is on by default here
 * because a hand resting on the phone is the common case.
 */
export default function PhoneApp() {
  const room = new URLSearchParams(location.search).get('room') || ''
  const sync = useWorkspace(room, 'phone')
  const canvas = useRef(null)

  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(PEN_COLORS[0])
  const [size, setSize] = useState(2.6)
  const [pages, setPages] = useState([])
  const [active, setActive] = useState(0)
  const [ink, setInk] = useState(0)

  // The phone is a whole client, not a pen that happens to have a screen: it
  // can ask, correct what was read, and read the answer. Anything it asks is
  // broadcast to the workspace, so the laptop shows it too - and anything the
  // laptop asks arrives here the same way.
  const [phase, setPhase] = useState('idle')   // idle|reading|review|solving|done
  const [question, setQuestion] = useState('')
  const [typed, setTyped] = useState('')
  const [steps, setSteps] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const mine = useRef(false)
  const shared = useSharedAnswer(sync)
  const scrollRef = useRef(null)
  const answerRef = useRef(null)
  const answering = phase === 'solving' || phase === 'done'

  // bring the answer into view the moment it starts being written
  useEffect(() => {
    if (phase === 'solving') {
      answerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [phase])

  // follow the laptop unless this phone is the one asking
  useEffect(() => {
    if (mine.current || !shared) return
    setQuestion(shared.question || '')
    setSteps(shared.steps || [])
    setPhase(shared.streaming ? 'solving' : 'done')
  }, [shared])

  const solve = async (text) => {
    const q = (text || '').trim()
    if (!q) return
    mine.current = true
    setErr(null); setQuestion(q); setSteps([]); setPhase('solving'); setBusy(true)
    const latest = { current: [] }
    streamSteps('/api/ai/solve', { question: q, room, provider: null }, {
      onSteps: (st) => { latest.current = st; setSteps(st) },
      onDone: () => { setPhase('done'); setBusy(false); mine.current = false },
      onError: (e) => {
        setErr(e.message); setPhase('idle'); setBusy(false); mine.current = false
      },
    })
  }

  // read the page, then let the student correct it before it is solved
  const readPage = async () => {
    if (!canvas.current) return
    setErr(null); setBusy(true); setPhase('reading')
    try {
      const png = canvas.current.toPng({ pad: 20, minSide: 40 })
      const out = await api.extract({ image: png })
      if (out.blank) {
        setErr('Nothing written on this page yet.')
        setPhase('idle'); setBusy(false); return
      }
      setQuestion(out.question || '')
      setPhase('review')
    } catch (e) {
      setErr(e.message); setPhase('idle')
    } finally {
      setBusy(false)
    }
  }

  const onPagesChange = useCallback((p, a) => { setPages(p); setActive(a) }, [])
  const onInkChange = useCallback((n) => setInk(n), [])

  useEffect(() => {
    // Keep the browser chrome from bouncing while writing - but only while
    // writing. Cancelling every touchmove on the document stopped the page
    // scrolling at all, so once an answer was longer than the screen there
    // was no way to reach the end of it. The pad still swallows the gesture
    // (it is .ink-surface, which is touch-action: none), and the rubber-band
    // on the rest of the page is already handled by overscroll-behavior.
    const stop = (e) => {
      const t = e.target
      if (t instanceof Element && t.closest('.ink-surface')) e.preventDefault()
    }
    const noZoom = (e) => e.preventDefault()
    document.addEventListener('gesturestart', noZoom)
    document.addEventListener('touchmove', stop, { passive: false })
    return () => {
      document.removeEventListener('gesturestart', noZoom)
      document.removeEventListener('touchmove', stop)
    }
  }, [])

  if (!room) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <h1 className="hand text-3xl">INKWISE</h1>
          <p className="mt-3 text-sm text-ink-soft">
            Open this page by scanning the QR code shown on your laptop.
          </p>
        </div>
      </div>
    )
  }

  const dot = sync.status === 'live' ? '#0ca30c'
    : sync.status === 'offline' ? '#d03b3b' : '#fab219'
  const laptops = sync.peers.filter((p) => p.role === 'laptop').length

  return (
    <div className="flex h-full flex-col bg-[#eceadf]"
         style={{ paddingTop: 'env(safe-area-inset-top)',
                  paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header className="flex items-center gap-2 bg-[#fbf9f3] px-3 py-2 text-xs">
        <span className="hand text-xl">INKWISE</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
          {sync.status}
        </span>
        <span className="text-ink-soft">
          {laptops ? 'laptop connected' : 'waiting for laptop'}
        </span>
        <span className="ml-auto text-ink-soft">
          p{active + 1}/{pages.length || 1} · {ink}
        </span>
        <button onClick={readPage} disabled={busy || !ink}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium
                           text-white disabled:opacity-40">
          {phase === 'reading' ? 'Reading…' : 'Solve'}
        </button>
      </header>

      {err && (
        <div className="bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
      )}

      {phase === 'review' && (
        <div className="bg-amber-50 px-3 py-2">
          <p className="mb-1 text-xs text-amber-900">
            Is this what you wrote? Correct it if not.
          </p>
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-amber-300 bg-white
                               px-2 py-1.5 text-sm" />
          <div className="mt-1.5 flex gap-2">
            <button onClick={() => solve(question)}
                    className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white">
              Yes — solve it
            </button>
            <button onClick={readPage}
                    className="rounded-lg border border-black/15 px-3 py-1.5 text-sm">
              Read again
            </button>
            <button onClick={() => setPhase('idle')}
                    className="px-2 py-1.5 text-sm text-ink-soft">cancel</button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {/* the pad has the screen to itself until there is an answer to read,
            then it gives up half of it rather than making the student scroll
            a full page of blank ruled paper to find the answer */}
        <div className={answering ? '' : 'h-full'}
             style={answering ? { height: '44vh' } : undefined}>
          <InkCanvas
            ref={canvas} sync={sync} tool={tool} color={color} size={size}
            palmRejection
            onPagesChange={onPagesChange} onInkChange={onInkChange}
          />
        </div>

        {phase === 'idle' && (
          <div data-paper className="ruled mt-2 rounded-sm px-3 py-1">
            <LinedInput value={typed} onChange={setTyped}
                        placeholder="…or type your question"
                        onSubmit={() => { solve(typed); setTyped('') }}
                        disabled={busy} />
          </div>
        )}

        {answering && (
          <div ref={answerRef} data-paper className="ruled mt-2 rounded-sm px-3 py-2">
            {question && (
              <p className="lined-row hand text-[1.1rem] text-ink-soft">{question}</p>
            )}
            <div className="lined-row hand text-[1.2rem] text-emerald-800">Answer</div>
            <AnswerSheet steps={steps} streaming={phase === 'solving'}
                         emptyHint="Working on it…" />
          </div>
        )}
      </div>

      <div className="scroll-thin flex items-center gap-1.5 overflow-x-auto
                      bg-[#fbf9f3] px-2 py-2">
        <Pill on={tool === 'pen'} onClick={() => setTool('pen')}>✒︎</Pill>
        <Pill on={tool === 'highlighter'} onClick={() => setTool('highlighter')}>▭</Pill>
        <Pill on={tool === 'eraser'} onClick={() => setTool('eraser')}>⌫</Pill>

        <span className="mx-0.5 h-6 w-px shrink-0 bg-black/10" />
        {PEN_COLORS.slice(0, 4).map((c) => (
          <button key={c} onClick={() => { setColor(c); setTool('pen') }}
                  className={`h-7 w-7 shrink-0 rounded-full ${
                    color === c ? 'ring-2 ring-ink ring-offset-1' : 'ring-1 ring-black/15'}`}
                  style={{ background: c }} />
        ))}

        <input type="range" min="1" max="6" step="0.2" value={size}
               onChange={(e) => setSize(parseFloat(e.target.value))}
               className="mx-1 w-16 shrink-0" />

        <span className="mx-0.5 h-6 w-px shrink-0 bg-black/10" />
        <Pill onClick={() => canvas.current?.undo()}>↶</Pill>
        <Pill onClick={() => canvas.current?.redo()}>↷</Pill>
        <Pill onClick={() => canvas.current?.addPage()}>+</Pill>
        <Pill onClick={() => {
          if (confirm('Clear this page for everyone?')) canvas.current?.clear()
        }}>✕</Pill>
      </div>
    </div>
  )
}

function Pill({ on, children, ...p }) {
  return (
    <button {...p}
      className={`min-w-[2.4rem] shrink-0 rounded-lg px-2 py-2 text-base ${
        on ? 'bg-ink text-white' : 'bg-black/5'}`}>
      {children}
    </button>
  )
}
