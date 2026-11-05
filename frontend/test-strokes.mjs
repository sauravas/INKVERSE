// Draw in the real React app, then verify what actually reached the server.
// This tests the browser -> WebSocket path that test_sync.py cannot reach.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const exe = CANDIDATES.find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const ROOM = 'strokecheck' + Date.now().toString(36).slice(-4)

const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 800))

const cv = await page.$('canvas.ink-surface')
const b = await cv.boundingBox()

// three strokes, each with many interpolated moves
for (let s = 0; s < 3; s++) {
  const y = 0.15 + s * 0.06
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      b.x + b.width * (0.2 + i * 0.05),
      b.y + b.height * (y + (i % 2 ? 0.03 : -0.02)),
      { steps: 12 },
    )
  }
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 120)) // let a frame flush
}
await new Promise((r) => setTimeout(r, 900))

const info = await (await fetch(`${BASE}/api/pair/session/${ROOM}`)).json()
console.log('server sees strokes:', info.strokes)

// pull per-stroke point counts out of the live room via a second client
const detail = await page.evaluate(async (room) => {
  const ws = new WebSocket(`ws://${location.host}/ws/${room}?role=probe`)
  const snap = await new Promise((res) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.t === 'welcome') res(m.snapshot)
    }
  })
  ws.close()
  return snap.pages[0].strokes.map((s) => ({ id: s.id, pts: s.pts.length, done: s.done }))
}, ROOM)

console.log('per-stroke point counts:', JSON.stringify(detail))
const total = detail.reduce((n, s) => n + s.pts, 0)
const allDone = detail.every((s) => s.done)
const enough = detail.every((s) => s.pts > 5)
console.log(`total points: ${total} | all closed: ${allDone} | every stroke >5 pts: ${enough}`)
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none')
console.log(enough && allDone && detail.length === 3 ? 'STROKE SYNC: PASS' : 'STROKE SYNC: FAIL')

await browser.close()
