// Stroke geometry and canvas rendering.
//
// Everything is stored in logical page units so that a phone and a laptop with
// different screens are writing on the same page. PAGE_W x PAGE_H is A4-shaped.

export const PAGE_W = 1000
export const PAGE_H = 1414

/**
 * Line spacing, in page units rather than pixels.
 *
 * The ruled lines belong to the page, not to the screen showing it. They used
 * to be a fixed 32px in CSS while the ink was scaled to whatever width the
 * canvas happened to have, so the two only lined up at one particular width:
 * a phone (page at ~35%) looked right and a laptop (page at ~81%) showed the
 * same handwriting at more than twice the height of its lines, spilling over
 * them. Measured from the phone, where it looked correct.
 */
export const RULE_UNITS = 90

/** Rule spacing in CSS pixels for a page drawn at this scale. */
export function rulePx(scale) {
  return RULE_UNITS * scale
}

export const PEN_COLORS = ['#16213a', '#1d4ed8', '#b91c1c', '#15803d', '#a16207']

// --- geometry --------------------------------------------------------------

/** Top-aligned, width-only fit: used when the container's height tracks the
 * ink instead of the other way round (see contentLogicalHeight below). */
export function widthFitBox(cw) {
  return { x: 0, y: 0, scale: cw / PAGE_W }
}

/**
 * How tall the visible page needs to be to show the ink plus room to keep
 * writing. Independent of PAGE_H: a 3-line question should not reserve an
 * entire notebook page before the answer can start.
 */
export function contentLogicalHeight(strokes, { minLogical = 260, padBottom = 170 } = {}) {
  let maxY = 0
  for (const s of strokes || []) {
    if (!s.pts || !s.pts.length) continue
    const half = (s.size || 2.4) * (s.tool === 'highlighter' ? 5 : 1)
    for (const p of s.pts) {
      const y = p[1] + half
      if (y > maxY) maxY = y
    }
  }
  return Math.min(PAGE_H, Math.max(minLogical, maxY + padBottom))
}

export function pageRect(cw, ch) {
  // letterbox the logical page into the available canvas, preserving aspect
  const scale = Math.min(cw / PAGE_W, ch / PAGE_H)
  const w = PAGE_W * scale
  const h = PAGE_H * scale
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale }
}

export function toLogical(clientX, clientY, rect, box) {
  return [
    ((clientX - rect.left) - box.x) / box.scale,
    ((clientY - rect.top) - box.y) / box.scale,
  ]
}

export function toScreen(x, y, box) {
  return [box.x + x * box.scale, box.y + y * box.scale]
}

// --- pressure / width ------------------------------------------------------

// Touchscreens often report pressure 0 or a constant 0.5. When pressure carries
// no information we fall back to speed: faster movement draws a thinner line,
// which is what gives finger-written text its natural taper.
export function widthFor(point, prev, baseSize, hasPressure) {
  const p = hasPressure ? Math.max(0.05, point[2]) : 0.5
  let w = baseSize * (0.45 + 1.15 * p)
  if (!hasPressure && prev) {
    const dx = point[0] - prev[0]
    const dy = point[1] - prev[1]
    const dt = Math.max(1, point[3] - prev[3])
    const speed = Math.hypot(dx, dy) / dt // logical units per ms
    const k = Math.min(1, speed / 2.2)
    w = baseSize * (1.25 - 0.6 * k)
  }
  return Math.max(0.35, w)
}

/**
 * Full-rate pointer samples for one move event.
 *
 * getCoalescedEvents() returns an EMPTY array for synthesized and some driver
 * pointer events, and `[] || fallback` keeps the empty array because [] is
 * truthy - which silently drops every sample. Check length explicitly.
 */
export function coalesced(nativeEvent) {
  const list = nativeEvent.getCoalescedEvents?.()
  return list && list.length ? list : [nativeEvent]
}

// --- smoothing -------------------------------------------------------------

// A light exponential filter on incoming coordinates removes digitiser jitter
// without adding visible lag.
export class Smoother {
  constructor(alpha = 0.45) {
    this.alpha = alpha
    this.last = null
  }
  push(pt) {
    if (!this.last) {
      this.last = pt.slice()
      return this.last.slice()
    }
    const a = this.alpha
    this.last = [
      this.last[0] + a * (pt[0] - this.last[0]),
      this.last[1] + a * (pt[1] - this.last[1]),
      this.last[2] + 0.6 * (pt[2] - this.last[2]),
      pt[3],
    ]
    return this.last.slice()
  }
  reset() {
    this.last = null
  }
}

// --- rendering -------------------------------------------------------------

function applyStyle(ctx, stroke) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.28
    ctx.globalCompositeOperation = 'multiply'
  } else {
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }
  ctx.strokeStyle = stroke.color || '#16213a'
}

/**
 * Draw a run of points. Each segment gets its own width, which is what produces
 * a tapered, pen-like line instead of a uniform tube. Segments are drawn through
 * midpoints so joins stay smooth.
 */
export function drawSegments(ctx, stroke, box, from = 0) {
  const pts = stroke.pts
  if (!pts || pts.length === 0) return
  const hasPressure = !!stroke.hasPressure
  const base = (stroke.size || 2.4) * (stroke.tool === 'highlighter' ? 5 : 1)

  applyStyle(ctx, stroke)

  if (pts.length === 1) {
    const [sx, sy] = toScreen(pts[0][0], pts[0][1], box)
    const w = widthFor(pts[0], null, base, hasPressure) * box.scale
    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(0.4, w / 2), 0, Math.PI * 2)
    ctx.fillStyle = stroke.color || '#16213a'
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  const start = Math.max(1, from)
  for (let i = start; i < pts.length; i++) {
    const p0 = pts[i - 1]
    const p1 = pts[i]
    const w = widthFor(p1, p0, base, hasPressure) * box.scale
    const [x0, y0] = toScreen(p0[0], p0[1], box)
    const [x1, y1] = toScreen(p1[0], p1[1], box)

    ctx.lineWidth = Math.max(0.3, w)
    ctx.beginPath()
    if (i === 1) {
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    } else {
      const pm = pts[i - 2]
      const [xm, ym] = toScreen(pm[0], pm[1], box)
      // quadratic through the midpoints either side of p0
      ctx.moveTo((xm + x0) / 2, (ym + y0) / 2)
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

export function drawStroke(ctx, stroke, box) {
  drawSegments(ctx, stroke, box, 0)
}

export function renderAll(ctx, strokes, box, w, h) {
  ctx.clearRect(0, 0, w, h)
  for (const s of strokes) drawStroke(ctx, s, box)
}

// --- hit testing (eraser) --------------------------------------------------

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function strokesNear(strokes, x, y, radius) {
  const hit = []
  for (const s of strokes) {
    const pts = s.pts
    if (!pts || !pts.length) continue
    const r = radius + (s.size || 2.4) / 2
    let found = false
    if (pts.length === 1) {
      found = Math.hypot(pts[0][0] - x, pts[0][1] - y) <= r
    } else {
      for (let i = 1; i < pts.length && !found; i++) {
        if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1],
                          pts[i][0], pts[i][1]) <= r) found = true
      }
    }
    if (found) hit.push(s.id)
  }
  return hit
}

// --- export to image -------------------------------------------------------

/**
 * Render strokes to a PNG data URL for the vision model. Crops to the ink with
 * padding: a mostly blank page wastes prefill tokens and hurts accuracy.
 */
export function strokesToPng(strokes, { pad = 48, minSide = 256, scale = 2 } = {}) {
  const live = strokes.filter((s) => s.pts && s.pts.length)
  if (!live.length) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of live) {
    const half = (s.size || 2.4) * (s.tool === 'highlighter' ? 5 : 1)
    for (const p of s.pts) {
      if (p[0] - half < minX) minX = p[0] - half
      if (p[1] - half < minY) minY = p[1] - half
      if (p[0] + half > maxX) maxX = p[0] + half
      if (p[1] + half > maxY) maxY = p[1] + half
    }
  }
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(PAGE_W, maxX + pad)
  maxY = Math.min(PAGE_H, maxY + pad)

  let w = Math.max(minSide, maxX - minX)
  let h = Math.max(minSide, maxY - minY)

  const cv = document.createElement('canvas')
  cv.width = Math.round(w * scale)
  cv.height = Math.round(h * scale)
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cv.width, cv.height)

  const box = { x: -minX * scale, y: -minY * scale, scale }
  for (const s of live) drawStroke(ctx, s, box)
  return cv.toDataURL('image/png')
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}
