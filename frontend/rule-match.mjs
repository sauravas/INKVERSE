/**
 * A sentence must sit between two lines, on any screen.
 *
 * Strokes are stored in page units and scaled to whatever width the canvas
 * has; the ruled lines are painted by the page wrapper in CSS. If those two
 * disagree you get the reported bug: writing that sits neatly between the
 * lines on a phone spills over three of them on a laptop.
 *
 * Two things are checked, because an earlier version of this test passed
 * while the bug was fully present. It read the variable the canvas sets
 * rather than the lines the page actually draws, so it confirmed a value and
 * proved nothing. This one measures the painted background as well.
 *
 *   node frontend\rule-match.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const ROOM = `rule${Math.random().toString(36).slice(2, 6)}`

// a line of handwriting, the size a hand writes at on a phone
const INK = []
for (let i = 0; i < 300; i++) {
  const t = i / 299
  INK.push({ x: 70 + t * 830, y: 150 + Math.sin(t * 50) * 26 + Math.sin(t * 6) * 9, p: 0.6 })
}
const INK_UNITS = 110          // peak-to-peak height of that stroke, in page units

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}

const browser = await chromium.launch({ executablePath: exe, headless: true })

// the phone writes the sentence, as it would in use
const phone = await browser.newPage({ viewport: { width: 412, height: 915 } })
await phone.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
await phone.waitForTimeout(1900)
await phone.evaluate(async ({ room, pts }) => {
  const ws = new WebSocket(`ws://${location.host}/ws/${room}?role=probe`)
  await new Promise((r) => { ws.onopen = r })
  const snap = await new Promise((r) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === 'welcome') r(d) }
    ws.send(JSON.stringify({ t: 'hello' }))
  })
  const pid = snap.snapshot?.pages?.[0]?.id
  ws.send(JSON.stringify({ t: 'stroke_begin', pageId: pid, id: 'rm1',
                           color: '#16213a', size: 3, points: pts }))
  ws.send(JSON.stringify({ t: 'stroke_end', pageId: pid, id: 'rm1' }))
  await new Promise((r) => setTimeout(r, 700))
}, { room: ROOM, pts: INK })
await phone.waitForTimeout(1400)

/** Measure the rule height the page actually paints, not the one it declares. */
const measure = (page) => page.evaluate(() => {
  const paper = document.querySelector('[data-paper]')
  const cv = document.querySelector('canvas')
  const cs = getComputedStyle(paper)
  const declared = parseFloat(cs.getPropertyValue('--rule'))
  // background-size resolves to real pixels, so it reflects what is drawn
  const painted = parseFloat((cs.backgroundSize || '').split(' ')[1]) || declared
  // and the gradient must still describe a hairline, not a band. Chrome
  // resolves the calc() into pixel stops, so the coloured part is the gap
  // between the last two of them.
  const stops = [...(cs.backgroundImage || "").matchAll(/([\d.]+)px/g)]
    .map((m) => parseFloat(m[1]))
  const line = stops.length >= 2 ? stops[stops.length - 1] - stops[stops.length - 2] : 99
  const bandy = line > 2
  return { paper: Math.round(paper.getBoundingClientRect().width),
           canvas: Math.round(cv.getBoundingClientRect().width),
           declared: +declared.toFixed(1), painted: +painted.toFixed(1),
           line: +line.toFixed(2), bandy }
})

const rows = []
const look = async (label, page) => {
  const m = await measure(page)
  const scale = m.canvas / 1000
  const inkRules = +((INK_UNITS * scale) / m.painted).toFixed(2)
  rows.push({ label, ...m, inkRules })
  console.log(`  ${label.padEnd(16)} paper ${String(m.paper).padStart(4)}  `
    + `canvas ${String(m.canvas).padStart(4)}  rule declared ${String(m.declared).padStart(5)} `
    + `painted ${String(m.painted).padStart(5)}  ink ${inkRules} rules`)
  return { ...m, inkRules }
}

console.log('the same sentence, on every screen:')
await look('phone', phone)
for (const [label, paperW] of [['laptop small', 520], ['laptop medium', 700],
                               ['laptop large', 880]]) {
  const p = await browser.newPage({ viewport: { width: 1512, height: 900 } })
  await p.addInitScript((v) => localStorage.setItem('inkwise.paper', String(v)), paperW)
  await p.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(2300)
  await look(label, p)
  await p.screenshot({ path: `../bench/rule-${paperW}.png` })
  await p.close()
}
await phone.close()
await browser.close()

console.log()
const ink = rows.map((r) => r.inkRules)
const spread = Math.max(...ink) - Math.min(...ink)
check('a sentence is the same height in rules everywhere',
  spread < 0.05, `spread ${spread.toFixed(2)} across ${ink.join(', ')}`)
check('and it fits between two lines rather than spilling over them',
  ink.every((v) => v > 0.5 && v < 2), ink.join(', '))
check('the painted lines match the declared rule height',
  rows.every((r) => Math.abs(r.painted - r.declared) < 0.5),
  rows.map((r) => `${r.label}: ${r.declared} vs ${r.painted}`).join('; '))
check('the rules are hairlines, not bands',
  rows.every((r) => !r.bandy),
  rows.map((r) => r.label + ': ' + r.line + 'px').join('; '))
check('a smaller page really is smaller',
  rows[1].painted < rows[3].painted,
  `${rows[1].painted} vs ${rows[3].painted}`)

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
