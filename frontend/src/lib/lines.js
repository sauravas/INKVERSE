// Ruled-paper geometry shared by everything that has to sit on the lines.
import katex from 'katex'

/** One ruled line, in CSS pixels (2rem). */
export function rulePx() {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return fs * 2
}

/** Round a height up to a whole number of ruled lines. */
export function snapToRules(px, min = 1) {
  const r = rulePx()
  return Math.max(min * r, Math.ceil((px - 0.5) / r) * r)
}

/** Distance from the top of an element to the baseline of its first line. */
function baselineOf(el) {
  const mark = document.createElement('span')
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
  el.appendChild(mark)
  const y = mark.getBoundingClientRect().top - el.getBoundingClientRect().top
  mark.remove()
  return y
}

/**
 * Measure the real fonts and put the rules where the writing actually sits.
 *
 * The rule is drawn on the last pixel of each line band; text inside that band
 * sits wherever its font's ascent/descent put the baseline. So the rules are
 * shifted to fall just under the handwriting's baseline, and inline KaTeX
 * (different font, different metrics) is nudged onto the same baseline.
 * Measured rather than hard-coded so it holds for any font or zoom level.
 */
export function calibrateLines() {
  const R = rulePx()
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;visibility:hidden'
  document.body.appendChild(host)
  try {
    const text = document.createElement('div')
    text.className = 'hand lined-text'
    text.style.fontSize = '1.42rem'
    text.textContent = 'Handwriting'
    host.appendChild(text)
    const textBase = baselineOf(text)
    const textPx = parseFloat(getComputedStyle(text).fontSize)

    const line = document.createElement('div')
    line.className = 'hand lined-text'
    line.style.fontSize = '1.42rem'
    const math = document.createElement('span')
    math.className = 'ink-math ink-math--tilt'
    math.style.top = '0'
    math.innerHTML = katex.renderToString('x', { throwOnError: false })
    line.appendChild(math)
    host.appendChild(line)
    const mathBase = baselineOf(math)

    // a rule 3px under the baseline reads as "written on the line"
    const shift = Math.round(textBase + 3 - (R - 1))
    const mathShiftEm = (textBase - mathBase) / textPx
    const root = document.documentElement.style
    root.setProperty('--rule-shift', `${shift}px`)
    root.setProperty('--math-shift', `${mathShiftEm.toFixed(3)}em`)
    return { rule: R, textBaseline: textBase, mathBaseline: mathBase, shift, mathShiftEm }
  } finally {
    host.remove()
  }
}
