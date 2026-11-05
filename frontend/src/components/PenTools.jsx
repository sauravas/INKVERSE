import { PEN_COLORS } from '../lib/ink'

/** Pen, highlighter, eraser, colours, width and history controls. */
export function PenTools({ tool, setTool, color, setColor, size, setSize, canvas }) {
  return (
    <>
      <ToolBtn on={tool === 'pen'} onClick={() => setTool('pen')} title="Pen (p)">✒︎ Pen</ToolBtn>
      <ToolBtn on={tool === 'highlighter'} onClick={() => setTool('highlighter')}
               title="Highlighter (h)">▭ Mark</ToolBtn>
      <ToolBtn on={tool === 'eraser'} onClick={() => setTool('eraser')}
               title="Eraser (e)">⌫ Erase</ToolBtn>
      <span className="mx-1 h-5 w-px shrink-0 bg-black/10" />
      {PEN_COLORS.map((c) => (
        <button key={c} onClick={() => { setColor(c); setTool('pen') }} title={c}
                className={`h-5 w-5 shrink-0 rounded-full ring-offset-1 ${
                  color === c ? 'ring-2 ring-ink' : 'ring-1 ring-black/15'}`}
                style={{ background: c }} />
      ))}
      <input type="range" min="1" max="6" step="0.2" value={size}
             onChange={(e) => setSize(parseFloat(e.target.value))}
             className="mx-2 w-20 shrink-0" title="Pen width" />
      <span className="mx-1 h-5 w-px shrink-0 bg-black/10" />
      <ToolBtn onClick={() => canvas.current?.undo()} title="Undo (Ctrl+Z)">↶</ToolBtn>
      <ToolBtn onClick={() => canvas.current?.redo()} title="Redo (Ctrl+Y)">↷</ToolBtn>
      <ToolBtn onClick={() => { if (confirm('Clear this page?')) canvas.current?.clear() }}>
        Clear
      </ToolBtn>
    </>
  )
}

export function ToolBtn({ on, children, ...p }) {
  return (
    <button {...p}
      className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${
        on ? 'bg-ink text-white' : 'hover:bg-black/5'}`}>{children}</button>
  )
}
