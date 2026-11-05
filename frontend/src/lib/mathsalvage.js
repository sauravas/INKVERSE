/**
 * What to show when KaTeX cannot parse what the model called mathematics.
 *
 * With throwOnError:false KaTeX renders the source itself in red, which is how
 * a page ends up covered in raw \text{...}\\ \quad - unreadable, and it looks
 * broken because it is. The usual cause is a model writing code as maths:
 *
 *   $$\text{def bfs(graph, start):}\\ \quad \text{queue = [start]}$$
 *
 * which is invalid the moment an identifier contains an underscore. The backend
 * now asks for a @@CODE block instead, but answers written before that are
 * already in the database, so a bad formula is repaired here on the way out
 * rather than left on the page.
 */

/** Does this "formula" look like code someone wrapped in LaTeX? */
export function looksLikeCode(tex) {
  if (!tex) return false
  const t = String(tex)
  if (!t.includes('\\text{')) return false
  // laid out in lines, or carrying the shape of a program
  return /\\\\/.test(t) || /\\quad/.test(t)
    || /\b(def|for|while|if|return|print|int|void|function|end|begin)\b/.test(t)
}

/** Pull the code back out of the LaTeX it was wrapped in. */
export function texToCode(tex) {
  let t = String(tex || '')
  t = t.replace(/\$\$?/g, '')
  t = t.replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, '\n')
  t = t.replace(/\\\\/g, '\n')                 // line breaks
  t = t.replace(/\\quad|\\qquad/g, '    ')     // indentation
  t = t.replace(/\\,|\\;|\\!|\\ /g, ' ')
  // \text{...}, \mathrm{...} and friends hold the actual characters
  t = t.replace(/\\(?:text|mathrm|texttt|mathtt|mbox)\s*\{([^{}]*)\}/g, '$1')
  t = t.replace(/\\[a-zA-Z]+/g, '')            // anything left is formatting
  t = t.replace(/[{}]/g, '')
  t = t.replace(/&/g, ' ')
  return t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim()
}

/**
 * A formula that is not code but still will not parse: show the mathematics as
 * words rather than as backslashes. Readable beats accurate here - the student
 * can still see what was meant, and nothing is coloured like an error.
 */
const WORDS = {
  '\\times': '×', '\\cdot': '·', '\\div': '÷', '\\pm': '±',
  '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈',
  '\\infty': '∞', '\\sum': 'Σ', '\\prod': 'Π', '\\int': '∫',
  '\\partial': '∂', '\\nabla': '∇', '\\rightarrow': '→',
  '\\to': '→', '\\Rightarrow': '⇒', '\\alpha': 'α',
  '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
  '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π',
  '\\sigma': 'σ', '\\phi': 'φ', '\\omega': 'ω',
  '\\Delta': 'Δ', '\\Omega': 'Ω', '\\ldots': '…',
  '\\dots': '…', '\\in': '∈', '\\subset': '⊂',
  '\\sqrt': '√', '\\le': '≤', '\\ge': '≥',
}

export function texToWords(tex) {
  let t = String(tex || '')
  t = t.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
  t = t.replace(/\\(?:text|mathrm|mathbf|mathit|texttt|operatorname)\s*\{([^{}]*)\}/g, '$1')
  t = t.replace(/\\left|\\right/g, '')
  for (const [k, v] of Object.entries(WORDS)) t = t.split(k).join(v)
  t = t.replace(/\\[a-zA-Z]+/g, '')
  t = t.replace(/[{}]/g, '')
  t = t.replace(/\s+/g, ' ')
  return t.trim()
}
