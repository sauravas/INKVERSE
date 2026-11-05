import katex from 'katex'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import HandDiagram, { diagramTimeline } from './HandDiagram'
import HandTable, { tableTimeline } from './HandTable'
import Snap from './Snap'

/**
 * Handwritten answer rendering.
 *
 * The writing animation is driven by its own clock, not by token arrival. The
 * model fills a buffer; the pen drains it at a readable speed and simply writes
 * faster when it falls behind. A stalled model pauses the nib; it never stutters
 * the text. If the answer is already complete (loaded from the DB) it is shown
 * at once rather than replayed.
 */

const BASE_CPS = 62        // characters per second at rest
const CATCH_UP = 3.2       // how much faster the pen may go when behind

const diagramChars = new WeakMap()

function segLen(s) {
  if (s.kind === 'break') return 1
  if (s.kind === 'diagram' && s.diagram) {
    // the pen keeps going at its usual pace while the diagram is drawn, so
    // the diagram is worth as many characters as it takes to draw
    if (!diagramChars.has(s.diagram)) {
      diagramChars.set(s.diagram,
        Math.ceil((diagramTimeline(s.diagram).total / 1000) * BASE_CPS))
    }
    return diagramChars.get(s.diagram)
  }
  if (s.kind === 'table' && s.table) {
    if (!diagramChars.has(s.table)) {
      diagramChars.set(s.table, Math.ceil((tableTimeline(s.table).total / 1000) * BASE_CPS))
    }
    return diagramChars.get(s.table)
  }
  return s.value?.length || 0
}

// --- handwriting realism ---------------------------------------------------
// Uniform glyphs are what make a handwriting font read as machine-made. Real
// writing wobbles: every letter sits at a slightly different angle, height and
// ink weight, and a hand drifts over the course of a line. The jitter below is
// deterministic (seeded by position) so text does not twitch as it re-renders.

function rand(seed, i, salt = 0) {
  const x = Math.sin(seed * 127.1 + i * 311.7 + salt * 74.7) * 43758.5453
  return x - Math.floor(x)
}

function glyphStyle(seed, i) {
  const drift = Math.sin((seed % 17) + i / 9) * 0.5      // slow baseline drift
  return {
    display: 'inline-block',
    transform: `translateY(${(rand(seed, i, 1) - 0.5) * 1.6 + drift}px) `
      + `rotate(${(rand(seed, i, 2) - 0.5) * 3.4}deg)`,
    fontVariationSettings: `'wght' ${430 + Math.round(rand(seed, i, 3) * 130)}`,
    // ink density varies with how hard a pen is pressed
    opacity: 0.84 + rand(seed, i, 4) * 0.16,
  }
}

/** Build per-character spans once; reveal by slicing the memoised array. */
function useGlyphs(text, seed) {
  return useMemo(() => {
    const out = []
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '\n') {
        out.push(<br key={i} />)
      } else if (ch === ' ') {
        // a plain space keeps the DOM smaller and word spacing natural
        out.push(' ')
      } else {
        out.push(<span key={i} style={glyphStyle(seed, i)}>{ch}</span>)
      }
    }
    return out
  }, [text, seed])
}

function HandRun({ text, seed, count }) {
  const glyphs = useGlyphs(text, seed)
  return <>{count >= text.length ? glyphs : glyphs.slice(0, Math.max(0, count))}</>
}

export function stepsFromEvents(events) {
  const steps = []
  let cur = null
  for (const e of events) {
    if (e.type === 'step_open') {
      cur = { index: e.index, title: e.title, final: e.final, segments: [] }
      steps.push(cur)
    } else if (e.type === 'segment' && cur) {
      cur.segments.push({ kind: e.kind, value: e.value, display: e.display,
                          ...(e.diagram ? { diagram: e.diagram } : {}),
                          ...(e.table ? { table: e.table } : {}) })
    }
  }
  return steps
}

/** Steady-rate reveal counter, independent of network timing. */
function useWriter(total, instant) {
  const [revealed, setRevealed] = useState(instant ? total : 0)
  const raf = useRef(0)
  const last = useRef(0)
  const acc = useRef(instant ? total : 0)

  useEffect(() => {
    if (instant) {
      acc.current = total
      setRevealed(total)
      return undefined
    }
    const tick = (ts) => {
      raf.current = requestAnimationFrame(tick)
      if (!last.current) { last.current = ts; return }
      const dt = Math.min(0.1, (ts - last.current) / 1000)
      last.current = ts
      const backlog = total - acc.current
      if (backlog <= 0) return
      const speed = BASE_CPS * (1 + Math.min(CATCH_UP, backlog / 420))
      acc.current = Math.min(total, acc.current + speed * dt)
      setRevealed(acc.current)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [total, instant])

  return Math.floor(revealed)
}

function MathSpan({ value, display }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(value, {
        displayMode: display, throwOnError: false, strict: false,
        trust: false, output: 'html',
      })
    } catch {
      return null
    }
  }, [value, display])

  if (!html) {
    return <code className="rounded bg-amber-50 px-1 text-[0.9em] text-ink-soft">{value}</code>
  }
  return (
    <span
      data-tex={value}
      className={`ink-math ${display ? 'block text-center' : 'ink-math--tilt'}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function Segment({ seg, revealed, offset, onAskBlock }) {
  const len = segLen(seg)
  const local = revealed - offset
  if (local <= 0) return null

  // a blank line in the model's text: the next line already starts on a rule
  if (seg.kind === 'break') return null

  if (seg.kind === 'diagram' && seg.diagram) {
    // mounted when the pen reaches it; animates only if it is being written
    // now, not when an already finished answer is opened
    return <HandDiagram diagram={seg.diagram} animate={local < len}
                        onNodeClick={onAskBlock} />
  }

  if (seg.kind === 'table' && seg.table) {
    return <Snap><HandTable table={seg.table} animate={local < len} /></Snap>
  }

  if (seg.kind === 'math') {
    const p = Math.max(0, Math.min(1, len ? local / len : 1))
    const reveal = p < 1 ? { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` } : undefined
    if (seg.display) {
      // display maths is centred in a whole number of ruled lines
      return (
        <Snap>
          <div style={reveal}><MathSpan value={seg.value} display /></div>
        </Snap>
      )
    }
    // same box as the maths inside it, so the line never changes height
    return (
      <span style={{ ...reveal, display: 'inline-block', height: 'var(--rule)',
                     verticalAlign: 'top' }}>
        <MathSpan value={seg.value} display={false} />
      </span>
    )
  }

  return <HandRun text={seg.value} seed={offset} count={Math.ceil(local)} />
}

const StepCard = memo(function StepCard({
  step, offset, revealed, selected, onSelect, onAsk, onAskBlock, writing,
}) {
  const total = step.segments.reduce((n, s) => n + segLen(s), 0)
  const localRevealed = revealed - offset
  if (localRevealed <= 0) return null

  const complete = localRevealed >= total
  let run = offset

  return (
    <section
      data-selected={selected ? 'true' : 'false'}
      data-step-index={step.index}
      onClick={() => onSelect?.(step)}
      className="step-card group cursor-pointer rounded-r-lg pl-4 pr-3"
    >
      <header className="lined-one flex items-baseline gap-2">
        <span className={`hand lined-text shrink-0 text-[1.45rem] ${
          step.final ? 'text-emerald-800' : 'text-accent'}`}>
          {step.final ? 'Answer' : `Step ${step.index}`}
        </span>
        {step.title && !step.final && (
          // models sometimes put LaTeX in a title despite being told not to
          <RichText text={step.title}
                    className="hand lined-text min-w-0 truncate text-[1.3rem] text-ink-soft" />
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAsk?.(step) }}
          className="step-ask ml-auto shrink-0 rounded-full border border-amber-300
                     bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800
                     hover:bg-amber-100 focus:opacity-100"
        >
          explain this
        </button>
      </header>

      <div className="hand lined-text whitespace-pre-wrap text-[1.42rem] text-ink">
        {step.segments.map((seg, i) => {
          const off = run
          run += segLen(seg)
          return <Segment key={i} seg={seg} revealed={revealed} offset={off}
                          onAskBlock={onAskBlock ? (label) => onAskBlock(step, label) : undefined} />
        })}
        {writing && !complete && <span className="nib" />}
      </div>
    </section>
  )
})

export default function AnswerSheet({
  steps, streaming, instant, selectedStep, onSelectStep, onAskStep, emptyHint,
  afterStep, onAskBlock,
}) {
  const offsets = useMemo(() => {
    const out = []
    let run = 0
    for (const s of steps) {
      out.push(run)
      run += s.segments.reduce((n, x) => n + segLen(x), 0)
    }
    return { offsets: out, total: run }
  }, [steps])

  const revealed = useWriter(offsets.total, !!instant)
  const writing = streaming || revealed < offsets.total

  if (!steps.length) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="hand lined-text max-w-sm text-[1.4rem] text-ink-soft/70">
          {emptyHint || 'Write a question on the page, then press Solve.'}
        </p>
      </div>
    )
  }

  return (
    // no dividers: a 1px border per step would walk the text off the rules
    <div>
      {steps.map((s, i) => (
        <div key={s.index}>
          <StepCard
            step={s}
            offset={offsets.offsets[i]}
            revealed={revealed}
            writing={writing}
            selected={selectedStep?.index === s.index}
            onSelect={onSelectStep}
            onAsk={onAskStep}
            onAskBlock={onAskBlock}
          />
          {afterStep?.(s)}
        </div>
      ))}
      {streaming && revealed >= offsets.total && (
        <div className="lined-row px-4 text-xs text-ink-soft/60">
          <span className="nib" /> thinking…
        </div>
      )}
    </div>
  )
}

// Same delimiters the backend parser accepts, for text that arrives already
// complete (a question, a saved follow-up) rather than as a stream.
const INLINE_SPLIT =
  /\$\$(.+?)\$\$|\\\[(.+?)\\\]|\\\((.+?)\\\)|\$([^$\n]+?)\$/gs

/** Render a plain string, typesetting any LaTeX it contains. */
/** Split a plain string into text and math segments. */
export function splitRich(text) {
  const out = []
  let pos = 0
  const re = new RegExp(INLINE_SPLIT)
  let m
  while ((m = re.exec(text || '')) !== null) {
    if (m.index > pos) out.push({ kind: 'text', value: text.slice(pos, m.index) })
    const display = m[1] !== undefined || m[2] !== undefined
    out.push({ kind: 'math', display, value: m[1] ?? m[2] ?? m[3] ?? m[4] })
    pos = m.index + m[0].length
  }
  if (pos < (text || '').length) out.push({ kind: 'text', value: text.slice(pos) })
  return out
}

/**
 * A string written out by the pen, at the same steady rate as answers.
 * Used to write a question-bank question onto the page when it opens.
 */
export function WrittenText({ text, className, animate = true }) {
  const segs = useMemo(() => splitRich(text), [text])
  const offsets = useMemo(() => {
    let run = 0
    return segs.map((s) => { const o = run; run += segLen(s); return o })
  }, [segs])
  const total = segs.reduce((n, s) => n + segLen(s), 0)
  const revealed = useWriter(total, !animate)
  return (
    <span className={className}>
      {segs.map((s, i) => (
        <Segment key={`${text.length}-${i}`} seg={s} revealed={revealed}
                 offset={offsets[i]} />
      ))}
      {revealed < total && <span className="nib" />}
    </span>
  )
}

export function RichText({ text, className }) {
  const parts = useMemo(() => splitRich(text), [text])

  return (
    <span className={className}>
      {parts.map((p, i) => (p.kind === 'math'
        ? <MathSpan key={i} value={p.value} display={p.display} />
        : <HandRun key={i} text={p.value} seed={i * 31 + 7} count={p.value.length} />))}
    </span>
  )
}

export function stepToText(step) {
  if (!step) return ''
  const body = step.segments.map((s) => {
    if (s.kind === 'break') return '\n'
    if (s.kind === 'math') return s.display ? `$$${s.value}$$` : `$${s.value}$`
    if (s.kind === 'diagram' && s.diagram) {
      // follow-up prompts need to know what was drawn, not just its title
      const name = Object.fromEntries(s.diagram.nodes.map((n) => [n.id, n.label]))
      const rel = s.diagram.edges.map((e) => `${name[e.from]} -> ${name[e.to]}`
        + (e.label ? ` (${e.label})` : '')).join('; ')
      return `\n[Diagram: ${s.diagram.title}. ${rel}]\n`
    }
    if (s.kind === 'table' && s.table) {
      const row = (r) => `| ${r.join(' | ')} |`
      return `\n${[row(s.table.header), row(s.table.header.map(() => '---')),
        ...s.table.rows.map(row)].join('\n')}\n`
    }
    return s.value
  }).join('')
  const head = step.final ? 'Final answer' : `Step ${step.index}: ${step.title || ''}`
  return `${head}\n${body}`.trim()
}

export function stepsToText(steps) {
  return steps.map(stepToText).join('\n\n')
}
