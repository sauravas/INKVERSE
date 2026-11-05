/**
 * The page must settle. Catches layout that never stops re-laying-out.
 *
 * The canvas sizes itself from its own content and writes that height onto
 * the element its ResizeObserver is watching. That is a feedback loop, and it
 * only has to oscillate when the new height is exactly enough to show or hide
 * the window's scrollbar: the scrollbar changes the width, the width changes
 * the height, and the two chase each other at frame rate. On screen that is
 * not a flicker so much as static.
 *
 * Fullscreen is where it bites, because it is a height the page was never
 * sized for. So this sweeps heights rather than testing one.
 *
 *   node frontend\oscillation-check.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const ROOM = `osc${Math.random().toString(36).slice(2, 6)}`

// enough ink that the page wants to be taller than a short window
const INK = []
for (let i = 0; i < 120; i++) {
  const t = i / 119
  INK.push({ x: 80 + (t * 820) % 820, y: 120 + t * 900, p: 0.6 })
}

const browser = await chromium.launch({ executablePath: exe, headless: true })
let worst = { changes: 0, size: null }

const seed = async (page) => page.evaluate(async ({ room, pts }) => {
  const ws = new WebSocket(`ws://${location.host}/ws/${room}?role=probe`)
  await new Promise((r) => { ws.onopen = r })
  const snap = await new Promise((r) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === 'welcome') r(d) }
    ws.send(JSON.stringify({ t: 'hello' }))
  })
  const pid = snap.snapshot?.pages?.[0]?.id
  const id = 'osc' + Math.random().toString(36).slice(2, 8)
  ws.send(JSON.stringify({ t: 'stroke_begin', pageId: pid, id,
                           color: '#16213a', size: 3, points: pts }))
  ws.send(JSON.stringify({ t: 'stroke_end', pageId: pid, id }))
  await new Promise((r) => setTimeout(r, 500))
}, { room: ROOM, pts: INK })

// sweep the heights a window actually takes, including fullscreen
const SIZES = []
for (let h = 700; h <= 1100; h += 40) SIZES.push([1512, h])
SIZES.push([1920, 1080], [1920, 1032], [2560, 1440])

let first = true
for (const [width, height] of SIZES) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1400)
  if (first) { await seed(page); first = false; await page.waitForTimeout(1200) }

  const r = await page.evaluate(async () => {
    const cv = document.querySelector('canvas')
    const wrap = cv?.parentElement
    if (!wrap) return { changes: 0, values: [] }
    const seen = []
    let last = null
    const t0 = performance.now()
    // watch for two seconds: a settled page changes height zero times
    while (performance.now() - t0 < 2000) {
      const h = Math.round(wrap.getBoundingClientRect().height)
      if (h !== last) { seen.push(h); last = h }
      await new Promise((r2) => requestAnimationFrame(r2))
    }
    return { changes: Math.max(0, seen.length - 1),
             values: [...new Set(seen)].slice(0, 6),
             scrollbar: window.innerWidth - document.documentElement.clientWidth }
  })
  const bad = r.changes > 2
  console.log(`${String(width).padStart(4)}x${String(height).padEnd(4)}  `
    + `height changes in 2s: ${String(r.changes).padStart(3)}  `
    + `scrollbar ${r.scrollbar}px  ${bad ? '<-- OSCILLATING ' + JSON.stringify(r.values) : ''}`)
  if (r.changes > worst.changes) worst = { changes: r.changes, size: `${width}x${height}` }
  await page.close()
}
await browser.close()

console.log()
if (worst.changes > 2) {
  console.log(`FAIL  the page never settles at ${worst.size} `
    + `(${worst.changes} height changes in 2 seconds)`)
  process.exit(1)
}
console.log('ALL PASSED  the page settles at every window size tried')
