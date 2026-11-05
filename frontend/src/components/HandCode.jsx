import { useMemo } from 'react'

/**
 * Code on a notebook page.
 *
 * Code is the one thing in an answer that must not be handwritten: indentation
 * carries meaning, `next_node` is not `next` subscript `node`, and a student
 * copying an algorithm out needs to see exactly what to type. So it gets a
 * monospace block, pinned to the ruled lines like everything else, revealed a
 * line at a time as the pen reaches it rather than letter by letter - that is
 * how you read code, and it keeps long lines from reflowing mid-write.
 */

const LANGS = {
  python: 'Python', py: 'Python', c: 'C', cpp: 'C++', 'c++': 'C++',
  java: 'Java', js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript',
  matlab: 'MATLAB', octave: 'Octave', sql: 'SQL', verilog: 'Verilog',
  vhdl: 'VHDL', asm: 'Assembly', bash: 'Shell', sh: 'Shell', r: 'R',
  pseudocode: 'Pseudocode', pseudo: 'Pseudocode', algorithm: 'Algorithm',
}

export function codeLines(code) {
  return (code?.text || '').split('\n')
}

/** How long the pen spends here, in characters, so the clock stays honest. */
export function codeLength(code) {
  return (code?.text || '').length
}

export default function HandCode({ code, revealed = 1 }) {
  const lines = useMemo(() => codeLines(code), [code])
  const label = LANGS[code?.language] || (code?.language
    ? code.language.charAt(0).toUpperCase() + code.language.slice(1)
    : 'Code')

  // reveal whole lines: how many are fully written by now
  const total = codeLength(code) || 1
  const upto = Math.max(0, Math.min(1, revealed)) * total
  let run = 0
  const shown = lines.map((l) => {
    const start = run
    run += l.length + 1
    return start < upto
  })
  const visible = shown.lastIndexOf(true) + 1

  return (
    <div className="my-1 overflow-hidden rounded-md border border-black/10 bg-[#f7f5ee]">
      <div className="flex items-center justify-between border-b border-black/10
                      bg-black/[0.03] px-3 py-1">
        <span className="text-[11px] font-medium tracking-wide text-ink-soft">
          {label}
        </span>
        <span className="text-[11px] text-ink-soft/70">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
      </div>
      <pre className="scroll-thin overflow-x-auto px-3 py-2 text-[0.92rem]
                      leading-[1.5] text-ink">
        <code className="font-mono">
          {lines.slice(0, Math.max(visible, 1)).map((l, i) => (
            <div key={i} className="whitespace-pre">
              <span className="mr-3 inline-block w-5 select-none text-right
                               text-[0.8em] text-ink-soft/40">{i + 1}</span>
              {l || ' '}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}
