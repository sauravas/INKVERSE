import { useCallback, useEffect, useRef, useState } from 'react'
import InkCanvas from './components/InkCanvas'
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

  const onPagesChange = useCallback((p, a) => { setPages(p); setActive(a) }, [])
  const onInkChange = useCallback((n) => setInk(n), [])

  useEffect(() => {
    // keep the browser chrome from bouncing while writing
    const stop = (e) => e.preventDefault()
    document.addEventListener('gesturestart', stop)
    document.addEventListener('touchmove', stop, { passive: false })
    return () => {
      document.removeEventListener('gesturestart', stop)
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
      </header>

      <div className="min-h-0 flex-1 p-2">
        <InkCanvas
          ref={canvas} sync={sync} tool={tool} color={color} size={size}
          palmRejection
          onPagesChange={onPagesChange} onInkChange={onInkChange}
        />
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
