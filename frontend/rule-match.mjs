/**
 * Handwriting must sit on the ruled lines at every screen size.
 *
 * The bug this guards: strokes are stored in page units and scaled to the
 * canvas, but the ruled lines were a fixed 32px in CSS. They agreed on a
 * phone, where the page is drawn at about a third of its size, and disagreed
 * badly on a laptop, where the same handwriting came out more than twice the
 * height of its own lines.
 *
 *   node frontend\rule-match.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const ROOM = `rulechk${Math.random().toString(36).slice(2, 6)}`

// One line of handwriting, in page units, the size a hand actually writes at
// on the phone: roughly one and a half rules tall.
const WORD = []
for (let i = 0; i < 90; i++) {
  const t = i / 89
  WORD.push({ x: 80 + t * 740, y: 150 + Math.sin(t * 22) * 55, p: 0.6 })
}

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}

const browser = await chromium.launch({ executablePath: exe, headless: true })
const results = {}

for (const [label, width, height] of [['phone', 412, 915],
                                      ['laptop', 1512, 900],
                                      ['wide', 1920, 1080]]) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)

  // put the same stroke on the page through the same socket the phone uses
  await page.evaluate(async ({ room, pts }) => {
    const ws = new WebSocket(`ws://${location.host}/ws/${room}?role=probe`)
    await new Promise((r) => { ws.onopen = r })
    const snap = await new Promise((r) => {
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === 'welcome') r(d) }
      ws.send(JSON.stringify({ t: 'hello' }))
    })
    const pid = snap.snapshot?.pages?.[0]?.id
    const id = 'probe' + Math.random().toString(36).slice(2, 8)
    ws.send(JSON.stringify({ t: 'stroke_begin', pageId: pid, id,
                             color: '#16213a', size: 3, points: pts }))
    ws.send(JSON.stringify({ t: 'stroke_end', pageId: pid, id }))
    await new Promise((r) => setTimeout(r, 600))
  }, { room: ROOM, pts: WORD })
  await page.waitForTimeout(1600)

  const m = await page.evaluate(() => {
    const cv = document.querySelector('canvas')
    const wrap = cv?.parentElement
    const rule = parseFloat(getComputedStyle(wrap || document.body)
      .getPropertyValue('--rule'))
    const cw = cv ? cv.getBoundingClientRect().width : 0
    return { canvas: Math.round(cw), scale: +(cw / 1000).toFixed(3), rule: +rule.toFixed(1) }
  })
  // the stroke spans 110 page units peak to peak; how many rules is that?
  const inkRules = +((110 * m.scale) / m.rule).toFixed(2)
  results[label] = { ...m, inkRules }
  console.log(`${label.padEnd(7)} canvas ${String(m.canvas).padStart(5)}px  `
    + `scale ${m.scale}  rule ${String(m.rule).padStart(5)}px  `
    + `ink is ${inkRules} rules tall`)
  await page.screenshot({ path: `../bench/rule-${label}.png` })
  await page.close()
}
await browser.close()

const vals = Object.values(results).map((r) => r.inkRules)
const spread = Math.max(...vals) - Math.min(...vals)
console.log()
check('handwriting is the same height in rules on every screen',
  spread < 0.05, `spread ${spread.toFixed(2)} rules across ${vals.join(', ')}`)
check('and it fits inside its lines rather than spilling over them',
  vals.every((v) => v < 2.2), vals.join(', '))
check('the rules scale with the page', results.phone.rule < results.laptop.rule,
  `phone ${results.phone.rule} vs laptop ${results.laptop.rule}`)

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
