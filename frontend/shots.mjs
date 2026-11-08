/**
 * Presentable screenshots of the real app, for talks and posts.
 *
 * Everything here is real: the ink is drawn stroke by stroke through the
 * browser's own pointer events, the questions go through the actual pipeline,
 * and the answers are whatever the local models wrote. Nothing is mocked and
 * no image is assembled afterwards.
 *
 *   node shots.mjs            (from frontend\)
 *
 * Writes bench/pic-*.png at 2x for a crisp result on a large screen.
 */
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const TAG = Date.now().toString(36).slice(-4)
const OUT = (n) => resolve(ROOT, `bench/pic-${n}.png`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// --------------------------------------------------------------- handwriting
/**
 * A single-stroke alphabet: each glyph is one or more polylines in a box
 * where y=0 is the ascender line, 0.42 the x-height, 1.0 the baseline and
 * 1.3 the descender. Drawn with a little jitter and slant it reads as
 * handwriting, because it is written the same way handwriting is - one
 * continuous pen path at a time - rather than stamped from a font.
 */
const G = {
  a: [[[0.5, 0.45], [0.32, 0.4], [0.13, 0.55], [0.11, 0.78], [0.26, 0.99], [0.46, 0.94], [0.5, 0.86]], [[0.5, 0.45], [0.5, 1.0]]],
  b: [[[0.1, 0.05], [0.1, 1.0]], [[0.1, 0.75], [0.22, 0.5], [0.42, 0.46], [0.53, 0.63], [0.48, 0.88], [0.3, 1.0], [0.13, 0.93]]],
  c: [[[0.52, 0.56], [0.36, 0.42], [0.15, 0.52], [0.11, 0.74], [0.22, 0.96], [0.44, 1.0], [0.54, 0.88]]],
  d: [[[0.52, 0.05], [0.5, 1.0]], [[0.52, 0.56], [0.34, 0.42], [0.13, 0.54], [0.11, 0.77], [0.24, 0.98], [0.44, 0.96]]],
  e: [[[0.13, 0.73], [0.5, 0.67], [0.46, 0.48], [0.26, 0.43], [0.12, 0.6], [0.14, 0.86], [0.32, 1.0], [0.52, 0.9]]],
  f: [[[0.46, 0.12], [0.31, 0.06], [0.21, 0.2], [0.2, 1.3]], [[0.05, 0.46], [0.46, 0.42]]],
  g: [[[0.5, 0.44], [0.5, 1.12], [0.4, 1.29], [0.18, 1.24]], [[0.5, 0.56], [0.33, 0.42], [0.13, 0.54], [0.12, 0.74], [0.27, 0.95], [0.46, 0.89]]],
  h: [[[0.1, 0.05], [0.1, 1.0]], [[0.1, 0.7], [0.26, 0.45], [0.46, 0.46], [0.53, 0.63], [0.52, 1.0]]],
  i: [[[0.26, 0.45], [0.25, 1.0]], [[0.26, 0.24], [0.27, 0.27]]],
  j: [[[0.4, 0.45], [0.38, 1.12], [0.28, 1.29], [0.12, 1.24]], [[0.4, 0.24], [0.41, 0.27]]],
  k: [[[0.1, 0.05], [0.1, 1.0]], [[0.5, 0.46], [0.12, 0.78]], [[0.25, 0.69], [0.52, 1.0]]],
  l: [[[0.2, 0.05], [0.19, 0.9], [0.31, 1.0]]],
  m: [[[0.08, 0.45], [0.08, 1.0]], [[0.08, 0.62], [0.2, 0.45], [0.32, 0.5], [0.33, 1.0]], [[0.33, 0.62], [0.46, 0.45], [0.58, 0.5], [0.6, 1.0]]],
  n: [[[0.1, 0.45], [0.1, 1.0]], [[0.1, 0.63], [0.26, 0.45], [0.45, 0.49], [0.51, 0.66], [0.5, 1.0]]],
  o: [[[0.31, 0.42], [0.12, 0.56], [0.11, 0.79], [0.29, 1.0], [0.49, 0.9], [0.51, 0.62], [0.31, 0.42]]],
  p: [[[0.1, 0.43], [0.09, 1.3]], [[0.1, 0.6], [0.29, 0.43], [0.49, 0.53], [0.5, 0.81], [0.32, 0.98], [0.12, 0.9]]],
  q: [[[0.5, 0.43], [0.5, 1.3]], [[0.5, 0.56], [0.33, 0.42], [0.13, 0.54], [0.12, 0.76], [0.28, 0.97], [0.47, 0.9]]],
  r: [[[0.13, 0.45], [0.12, 1.0]], [[0.13, 0.63], [0.29, 0.45], [0.46, 0.46]]],
  s: [[[0.49, 0.51], [0.31, 0.42], [0.14, 0.51], [0.21, 0.66], [0.41, 0.73], [0.47, 0.88], [0.3, 1.0], [0.12, 0.92]]],
  t: [[[0.26, 0.14], [0.25, 0.88], [0.4, 1.0]], [[0.08, 0.46], [0.46, 0.43]]],
  u: [[[0.1, 0.45], [0.1, 0.86], [0.23, 1.0], [0.43, 0.94], [0.5, 0.8]], [[0.5, 0.45], [0.5, 1.0]]],
  v: [[[0.08, 0.45], [0.3, 1.0], [0.53, 0.45]]],
  w: [[[0.06, 0.45], [0.2, 1.0], [0.33, 0.62], [0.46, 1.0], [0.6, 0.45]]],
  x: [[[0.1, 0.46], [0.5, 1.0]], [[0.51, 0.45], [0.1, 1.0]]],
  y: [[[0.1, 0.45], [0.31, 0.95]], [[0.53, 0.45], [0.2, 1.3], [0.05, 1.24]]],
  z: [[[0.1, 0.46], [0.5, 0.45], [0.12, 1.0], [0.53, 0.99]]],
  A: [[[0.06, 1.0], [0.3, 0.05], [0.55, 1.0]], [[0.16, 0.69], [0.45, 0.69]]],
  B: [[[0.12, 1.0], [0.12, 0.05], [0.4, 0.07], [0.51, 0.26], [0.38, 0.48], [0.12, 0.5]], [[0.12, 0.5], [0.43, 0.56], [0.55, 0.76], [0.4, 0.98], [0.12, 1.0]]],
  C: [[[0.53, 0.2], [0.35, 0.05], [0.15, 0.21], [0.1, 0.55], [0.19, 0.9], [0.39, 1.0], [0.55, 0.85]]],
  D: [[[0.12, 0.05], [0.12, 1.0], [0.35, 0.98], [0.53, 0.75], [0.53, 0.32], [0.35, 0.07], [0.12, 0.05]]],
  E: [[[0.52, 0.06], [0.12, 0.05], [0.12, 1.0], [0.52, 0.99]], [[0.12, 0.52], [0.41, 0.52]]],
  F: [[[0.12, 0.05], [0.11, 1.0]], [[0.12, 0.05], [0.52, 0.06]], [[0.12, 0.5], [0.43, 0.5]]],
  G: [[[0.53, 0.2], [0.35, 0.05], [0.15, 0.21], [0.1, 0.55], [0.19, 0.9], [0.39, 1.0], [0.56, 0.84], [0.56, 0.6], [0.37, 0.6]]],
  H: [[[0.1, 0.05], [0.1, 1.0]], [[0.52, 0.05], [0.52, 1.0]], [[0.1, 0.55], [0.52, 0.55]]],
  I: [[[0.26, 0.05], [0.25, 1.0]]],
  J: [[[0.46, 0.05], [0.45, 0.86], [0.3, 1.0], [0.14, 0.9]]],
  K: [[[0.1, 0.05], [0.1, 1.0]], [[0.52, 0.05], [0.12, 0.6]], [[0.25, 0.48], [0.54, 1.0]]],
  L: [[[0.12, 0.05], [0.12, 1.0], [0.52, 0.99]]],
  M: [[[0.06, 1.0], [0.06, 0.05], [0.33, 0.62], [0.6, 0.05], [0.6, 1.0]]],
  N: [[[0.1, 1.0], [0.1, 0.05], [0.51, 1.0], [0.51, 0.05]]],
  O: [[[0.33, 0.05], [0.12, 0.26], [0.1, 0.66], [0.31, 1.0], [0.51, 0.85], [0.55, 0.4], [0.33, 0.05]]],
  P: [[[0.12, 1.0], [0.12, 0.05], [0.41, 0.07], [0.53, 0.26], [0.42, 0.46], [0.12, 0.5]]],
  Q: [[[0.33, 0.05], [0.12, 0.26], [0.1, 0.66], [0.31, 1.0], [0.51, 0.85], [0.55, 0.4], [0.33, 0.05]], [[0.38, 0.78], [0.58, 1.1]]],
  R: [[[0.12, 1.0], [0.12, 0.05], [0.41, 0.07], [0.53, 0.26], [0.42, 0.46], [0.12, 0.5]], [[0.3, 0.5], [0.54, 1.0]]],
  S: [[[0.53, 0.16], [0.31, 0.05], [0.14, 0.21], [0.23, 0.43], [0.46, 0.56], [0.53, 0.79], [0.35, 0.99], [0.12, 0.88]]],
  T: [[[0.05, 0.07], [0.52, 0.05]], [[0.29, 0.06], [0.28, 1.0]]],
  U: [[[0.1, 0.05], [0.1, 0.81], [0.31, 1.0], [0.51, 0.8], [0.51, 0.05]]],
  V: [[[0.05, 0.05], [0.3, 1.0], [0.56, 0.05]]],
  W: [[[0.05, 0.05], [0.2, 1.0], [0.34, 0.36], [0.48, 1.0], [0.63, 0.05]]],
  X: [[[0.08, 0.05], [0.53, 1.0]], [[0.53, 0.05], [0.08, 1.0]]],
  Y: [[[0.08, 0.05], [0.3, 0.55], [0.53, 0.05]], [[0.3, 0.55], [0.3, 1.0]]],
  Z: [[[0.08, 0.06], [0.53, 0.05], [0.1, 1.0], [0.55, 0.99]]],
  0: [[[0.31, 0.08], [0.12, 0.3], [0.12, 0.78], [0.31, 1.0], [0.49, 0.78], [0.49, 0.3], [0.31, 0.08]]],
  1: [[[0.15, 0.26], [0.3, 0.08], [0.29, 1.0]]],
  2: [[[0.12, 0.25], [0.3, 0.06], [0.5, 0.23], [0.4, 0.5], [0.12, 1.0], [0.53, 0.99]]],
  3: [[[0.12, 0.16], [0.32, 0.05], [0.5, 0.21], [0.3, 0.5], [0.53, 0.68], [0.45, 0.95], [0.15, 1.0]]],
  4: [[[0.41, 0.05], [0.1, 0.71], [0.53, 0.7]], [[0.41, 0.45], [0.4, 1.0]]],
  5: [[[0.5, 0.07], [0.16, 0.07], [0.13, 0.46], [0.33, 0.4], [0.53, 0.61], [0.45, 0.92], [0.15, 0.98]]],
  6: [[[0.48, 0.1], [0.25, 0.21], [0.12, 0.56], [0.15, 0.86], [0.35, 1.0], [0.5, 0.8], [0.4, 0.59], [0.17, 0.61]]],
  7: [[[0.1, 0.08], [0.53, 0.07], [0.28, 1.0]]],
  8: [[[0.32, 0.5], [0.15, 0.35], [0.2, 0.12], [0.42, 0.1], [0.48, 0.33], [0.32, 0.5], [0.14, 0.66], [0.15, 0.9], [0.35, 1.0], [0.5, 0.85], [0.46, 0.62], [0.32, 0.5]]],
  9: [[[0.5, 0.46], [0.3, 0.56], [0.14, 0.41], [0.2, 0.15], [0.45, 0.1], [0.52, 0.36], [0.45, 0.8], [0.26, 1.0]]],
  '+': [[[0.1, 0.72], [0.52, 0.71]], [[0.31, 0.5], [0.31, 0.93]]],
  '-': [[[0.1, 0.72], [0.52, 0.71]]],
  '=': [[[0.1, 0.61], [0.52, 0.59]], [[0.1, 0.83], [0.52, 0.81]]],
  '(': [[[0.36, 0.05], [0.18, 0.36], [0.18, 0.76], [0.36, 1.06]]],
  ')': [[[0.15, 0.05], [0.33, 0.36], [0.33, 0.76], [0.15, 1.06]]],
  '.': [[[0.2, 0.97], [0.22, 1.0]]],
  ',': [[[0.23, 0.94], [0.16, 1.13]]],
  '?': [[[0.12, 0.21], [0.3, 0.05], [0.49, 0.21], [0.38, 0.46], [0.3, 0.56], [0.3, 0.71]], [[0.3, 0.95], [0.31, 0.98]]],
  '/': [[[0.46, 0.05], [0.1, 1.0]]],
  '^': [[[0.14, 0.3], [0.26, 0.12], [0.38, 0.3]]],
  // a tall integral sign, and small raised digits for powers
  '∫': [[[0.50, 0.18], [0.55, 0.05], [0.63, 0.03], [0.66, 0.12], [0.59, 0.28],
         [0.49, 0.56], [0.39, 0.86], [0.30, 1.12], [0.22, 1.27], [0.13, 1.30], [0.09, 1.21]]],
  'ˣ': [[[0.12, 0.12], [0.34, 0.40]], [[0.34, 0.12], [0.12, 0.40]]],
  '²': [[[0.12, 0.19], [0.23, 0.08], [0.35, 0.17], [0.28, 0.31], [0.12, 0.46], [0.37, 0.45]]],
  '³': [[[0.12, 0.13], [0.26, 0.06], [0.35, 0.17], [0.24, 0.27], [0.37, 0.35], [0.3, 0.47], [0.13, 0.46]]],
  ' ': [],
}
const WIDE = new Set(['m', 'w', 'M', 'W'])

/** Where each character's strokes land on the page, in canvas pixels. */
function layout(text, { x, y, size, slant = 0.14, jitter = 0.012 }) {
  const rnd = (i) => {
    const s = Math.sin(i * 12.9898 + text.length * 4.1) * 43758.5453
    return (s - Math.floor(s) - 0.5) * 2
  }
  const out = []
  let cx = x
  let n = 0
  for (const ch of text) {
    const glyph = G[ch] ?? G['?']
    const w = (WIDE.has(ch) ? 0.74 : 0.62) * size
    for (const poly of glyph) {
      const pts = poly.map(([px, py], k) => {
        const jx = rnd(n * 7 + k) * jitter * size
        const jy = rnd(n * 7 + k + 3) * jitter * size
        // the slant tilts the whole letter the way a right-hander writes
        return [cx + px * size + (1 - py) * slant * size + jx, y + py * size + jy]
      })
      out.push(pts)
      n++
    }
    cx += w
  }
  return { strokes: out, width: cx - x }
}

/** Draw the polylines through the browser's real pointer input. */
async function write(page, strokes) {
  for (const pts of strokes) {
    if (!pts.length) continue
    await page.mouse.move(pts[0][0], pts[0][1])
    await page.mouse.down()
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]
      const [bx, by] = pts[i]
      // interpolate so the app sees a smooth path, not a jump
      const steps = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 3))
      for (let s = 1; s <= steps; s++) {
        await page.mouse.move(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps)
      }
    }
    await page.mouse.up()
  }
}

async function handwrite(page, lines, opts) {
  const cv = await page.$('canvas.ink-surface')
  const b = await cv.boundingBox()
  let y = b.y + opts.top
  for (const line of lines) {
    const { strokes } = layout(line, { x: b.x + opts.left, y, size: opts.size })
    await write(page, strokes)
    y += opts.lead
  }
}

// ------------------------------------------------------------------- driving
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         args: ['--no-sandbox', '--force-device-scale-factor=2'] })

async function open({ width = 1600, height = 1040, rails = false, room }) {
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 2 })
  await page.evaluateOnNewDocument((r) => {
    localStorage.setItem('inkwise.rails', r ? '1' : '0')
    localStorage.setItem('inkwise.calm', '1')
  }, rails)
  await page.goto(`${BASE}/?room=${room}`, { waitUntil: 'domcontentloaded' })
  await wait(1600)
  await page.evaluate(() => document.fonts.ready)
  return page
}

const click = (page, txt, exact) => page.evaluate((x, ex) => {
  const b = [...document.querySelectorAll('button')].find((e) =>
    ex ? e.textContent.trim().toLowerCase() === x : e.textContent.includes(x))
  b?.click(); return !!b
}, txt, exact)

/**
 * Wait until the answer is actually finished.
 *
 * Sampling the text and calling it done when two reads match is not enough:
 * the model pauses between tokens and the screenshot lands on "thinking...".
 * The app says so itself - the button reads Stop while a solve is running -
 * so wait for that, then for the handwriting to finish being written out.
 */
async function settled(page, limit = 240) {
  for (let i = 0; i < limit; i++) {
    await wait(1000)
    const running = await page.evaluate(() => [...document.querySelectorAll('button')]
      .some((b) => b.textContent.trim() === 'Stop'))
    if (!running && i > 2) break
  }
  // the writing animation keeps going after the last token arrives
  let last = -1
  let same = 0
  for (let i = 0; i < 40; i++) {
    await wait(700)
    const n = await page.evaluate(() =>
      (document.querySelector('.ruled')?.innerText || '').length)
    same = n === last ? same + 1 : 0
    last = n
    if (same >= 4 && n > 0) return true
  }
  return false
}

const shots = []
async function snap(page, name, note) {
  await page.screenshot({ path: OUT(name) })
  shots.push(`bench/pic-${name}.png — ${note}`)
  console.log(`  ✓ pic-${name}.png  ${note}`)
}

// 1 -------------------------------------------------- handwriting + an answer
console.log('\n1. handwritten question, solved')
{
  const page = await open({ room: `pic1-${TAG}` })
  await handwrite(page, ['Find  ∫ x² sin x dx'], { top: 150, left: 120, size: 54, lead: 92 })
  await wait(600)
  await snap(page, 'ink', 'handwriting on the pad, before anything is asked')

  await click(page, 'Solve')
  for (let i = 0; i < 90; i++) {
    await wait(1000)
    if (await page.evaluate(() => document.body.innerText.includes('Looks right'))) break
  }
  await wait(400)
  await snap(page, 'verify', 'the reading shown back for confirmation before solving')

  // accept the reading and let it solve
  await click(page, 'Looks right')
  await settled(page)
  await snap(page, 'answer', 'the answer written out on the page, not in a chat')
  await page.close()
}

// 2 ------------------------------------------------------------ a real figure
console.log('\n2. labelled figure')
{
  const page = await open({ room: `pic2-${TAG}` })
  const field = await page.$('input[type="text"], textarea, [contenteditable="true"]')
  if (field) {
    await field.click()
    await field.type('Draw a labelled diagram of the human heart')
    await page.keyboard.press('Enter')
  }
  await settled(page)
  const fig = await page.$('.ink-diagram')
  if (fig) {
    await fig.evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await wait(500)
  }
  await snap(page, 'diagram', 'a labelled heart - our geometry, the model only names the parts')
  await page.close()
}

// 3 ------------------------------------------------------------ observability
console.log('\n3. the agents, while they work')
{
  const page = await open({ room: `pic3-${TAG}`, rails: true })
  const field = await page.$('input[type="text"], textarea, [contenteditable="true"]')
  if (field) {
    await field.click()
    await field.type('Solve x² - 5x + 6 = 0 and explain each step')
    await page.keyboard.press('Enter')
  }
  await wait(9000)
  await snap(page, 'agents-live', 'the agent flow mid-run')
  await settled(page)
  await snap(page, 'agents-done', 'the traced run after it finishes')
  await page.close()
}

// 4 --------------------------------------------------------------- dashboard
console.log('\n4. deterministic dashboard')
{
  const page = await open({ room: `pic4-${TAG}` })
  await click(page, 'dashboard', true)
  await wait(1800)
  await snap(page, 'dashboard', 'exam readiness, computed from recall records')
  await page.close()
}

// 5 ------------------------------------------------------------- the phone
console.log('\n5. the phone as a second screen')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 3, isMobile: true,
                           hasTouch: true })
  await page.goto(`${BASE}/phone?room=pic1-${TAG}`, { waitUntil: 'domcontentloaded' })
  await wait(2200)
  await page.evaluate(() => document.fonts.ready)
  await snap(page, 'phone', 'the same workspace on the phone, paired by QR')
  await page.close()
}

await browser.close()
console.log('\nwritten:')
for (const s of shots) console.log('  ' + s)
