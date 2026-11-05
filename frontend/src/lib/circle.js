// What did the student circle? Given a loop drawn over an answer (in client
// coordinates), find the diagram blocks, formulas, table cells and words
// whose centres fall inside it, and which step they belong to.

export function pointInPolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Is this stroke a loop (roughly closed and big enough to mean something)? */
export function isLoop(pts) {
  if (pts.length < 8) return false
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  if (w < 18 || h < 12) return false
  const [x0, y0] = pts[0]
  const [x1, y1] = pts[pts.length - 1]
  return Math.hypot(x1 - x0, y1 - y0) <= Math.max(36, 0.4 * Math.hypot(w, h))
}

const centre = (el) => {
  const r = el.getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
}

/** Words inside the loop, rebuilt from the per-character handwriting glyphs. */
function circledWords(stepEl, poly) {
  const out = []
  let gap = false
  const walk = document.createTreeWalker(stepEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === 1) {
      const el = n
      // maths, diagrams and tables are reported separately
      if (el.closest('.ink-math, .ink-diagram, .hand-table, header')) continue
      if (el.tagName === 'BR') { gap = true; continue }
      if (el.tagName === 'SPAN' && el.childElementCount === 0 && el.textContent.length === 1) {
        if (pointInPolygon(...centre(el), poly)) {
          if (gap && out.length) out.push(' ')
          out.push(el.textContent)
          gap = false
        } else if (out.length) gap = true
      }
    } else if (/^\s+$/.test(n.textContent) && out.length) {
      gap = true
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim()
}

export function resolveCircle(root, poly) {
  // only the answer's own steps, not the steps of explanations inside margins
  const steps = [...root.querySelectorAll('[data-step-index]')]
    .filter((el) => !el.parentElement?.closest('[data-step-index]'))
  let best = null
  for (const el of steps) {
    const inside = (sel, attr) => [...el.querySelectorAll(sel)]
      .filter((x) => pointInPolygon(...centre(x), poly)).map((x) => x.getAttribute(attr))
    const blocks = [...new Set(inside('[data-block]', 'data-block'))]
    const maths = [...new Set(inside('[data-tex]', 'data-tex'))]
    const cells = inside('[data-cell]', 'data-cell').filter(Boolean)
    let words = circledWords(el, poly)
    // a loop round a formula or block clips a letter or two of the words
    // beside it; those fragments are noise, not something the student meant
    if ((blocks.length || maths.length || cells.length) && words.replace(/\s/g, '').length < 4) {
      words = ''
    }
    const score = blocks.length * 3 + maths.length * 2 + cells.length + (words ? words.length / 6 : 0)
    if (score > 0 && (!best || score > best.score)) {
      best = { score, stepIndex: Number(el.dataset.stepIndex), blocks, maths, cells, words }
    }
  }
  if (!best) return null
  const parts = []
  if (best.blocks.length) parts.push(`the diagram block${best.blocks.length > 1 ? 's' : ''} ${best.blocks.map((b) => `"${b}"`).join(', ')}`)
  if (best.maths.length) parts.push(`the formula${best.maths.length > 1 ? 's' : ''} ${best.maths.map((m) => `$${m}$`).join(', ')}`)
  if (best.cells.length) parts.push(`the table entr${best.cells.length > 1 ? 'ies' : 'y'} ${best.cells.map((c) => `"${c}"`).join(', ')}`)
  if (best.words) parts.push(`the words "${best.words.slice(0, 160)}"`)
  return { ...best, focus: parts.join('; ') }
}
