// Highlights on handwritten text without changing the DOM.
//
// Every character of handwriting is its own <span>, so wrapping a selection in
// a <mark> would break the glyphs apart. Instead a highlight is stored as the
// quoted text, found again in the rendered text, and painted with the CSS
// Custom Highlight API, which draws over ranges without touching elements.

/** Find `quote` inside `root` (ignoring whitespace differences) as a Range. */
export function findQuote(root, quote) {
  const want = (quote || '').replace(/\s+/g, '')
  if (!root || want.length < 2) return null
  const map = []
  let text = ''
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // maths is typeset by KaTeX; its text is not what the student selected
    acceptNode: (n) => (n.parentElement?.closest('.katex, svg, header')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const s = n.textContent
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue
      map.push([n, i])
      text += s[i]
    }
  }
  const at = text.indexOf(want)
  if (at < 0) return null
  const [sn, so] = map[at]
  const [en, eo] = map[at + want.length - 1]
  const r = document.createRange()
  r.setStart(sn, so)
  r.setEnd(en, eo + 1)
  return r
}

export function canHighlight() {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

/** Paint every range under one highlight name (replacing the previous set). */
export function paint(name, ranges) {
  if (!canHighlight()) return
  const live = ranges.filter(Boolean)
  if (live.length) CSS.highlights.set(name, new Highlight(...live))
  else CSS.highlights.delete(name)
}
