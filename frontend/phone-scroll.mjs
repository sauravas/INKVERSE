/**
 * The phone page has to scroll once there is an answer under the pad.
 *
 * Reported from a real phone: it does not. This loads /phone in a touch
 * emulated viewport, puts a long answer on the page the way a solve does,
 * and then asks the two questions that separate the possible causes - is
 * there anything to scroll (content taller than the box), and does a touch
 * drag actually move it.
 *
 *   node phone-scroll.mjs        (from frontend\)
 */
import { chromium, devices } from 'playwright-core'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const ROOM = `ps${Math.random().toString(36).slice(2, 6)}`

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ ...devices['Pixel 7'] })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

await page.goto(`${BASE}/phone?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
await wait(1800)

const box = () => page.evaluate(() => {
  const el = document.querySelector('.scroll-thin.overflow-y-auto')
  if (!el) return null
  const cs = getComputedStyle(el)
  const root = document.getElementById('root')
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: cs.overflowY,
    touchAction: cs.touchAction,
    rootH: root.getBoundingClientRect().height,
    winH: window.innerHeight,
    // how much of the box the canvas is covering: a drag that starts on the
    // pad is a pen stroke, not a scroll, so this decides whether there is
    // anywhere left to drag
    padH: document.querySelector('.ink-surface')?.getBoundingClientRect().height || 0,
  }
})

console.log('idle (nothing answered yet):')
let b = await box()
check('the scroll box exists', !!b)
console.log(`  root ${Math.round(b.rootH)}px, window ${b.winH}px, `
  + `box ${b.clientHeight}px tall holding ${b.scrollHeight}px, pad ${Math.round(b.padH)}px`)
check('the page itself is not taller than the window',
  b.rootH <= b.winH + 1, `root ${Math.round(b.rootH)} vs window ${b.winH}`)

// an answer arrives, exactly as a solve delivers one over the socket
await page.evaluate((room) => {
  const steps = Array.from({ length: 6 }, (_, i) => ({
    index: i + 1, title: `Step ${i + 1}`, final: i === 5,
    segments: [{ kind: 'text', display: false,
                 value: `Working for step ${i + 1}. `.repeat(8) }],
  }))
  window.dispatchEvent(new CustomEvent('inkwise:test-answer', { detail: { room, steps } }))
}, ROOM)
await wait(400)

// the event hook only exists if the app offers one; fall back to the real
// path, which is what a phone actually does: ask the server to solve
let answered = await page.evaluate(() =>
  !!document.querySelector('[data-step-index]'))
if (!answered) {
  console.log('\n  (no test hook; driving the real solve path instead)')
  const field = await page.$('input[type="text"], textarea, [contenteditable="true"]')
  if (field) {
    await field.click()
    await field.type('What is 2 + 2?')
    await page.keyboard.press('Enter')
  }
  for (let i = 0; i < 60 && !answered; i++) {
    await wait(1000)
    answered = await page.evaluate(() => !!document.querySelector('[data-step-index]'))
  }
}
check('an answer is on the page', answered)

// and wait for it to stop growing, or the measurement below is about a
// three-line answer that legitimately fits
let last = -1
for (let i = 0; i < 90; i++) {
  await wait(1000)
  const h = await page.evaluate(() =>
    document.querySelector('.scroll-thin.overflow-y-auto')?.scrollHeight || 0)
  if (h === last) break
  last = h
}

console.log('\nwith an answer under the pad:')
b = await box()
console.log(`  box ${b.clientHeight}px tall holding ${b.scrollHeight}px, `
  + `overflow-y: ${b.overflowY}, touch-action: ${b.touchAction}, `
  + `pad ${Math.round(b.padH)}px`)
check('there is something to scroll',
  b.scrollHeight > b.clientHeight + 4,
  `${b.scrollHeight} vs ${b.clientHeight}`)

// a real touch drag, started below the pad so it is a scroll and not a stroke
const target = await page.evaluate(() => {
  const el = document.querySelector('.scroll-thin.overflow-y-auto')
  const r = el.getBoundingClientRect()
  const pad = document.querySelector('.ink-surface')?.getBoundingClientRect()
  const belowPad = pad ? pad.bottom + 30 : r.top + r.height * 0.8
  return { x: r.left + r.width / 2, y: Math.min(belowPad, r.bottom - 20) }
})
// A real touch drag, through the browser's own input pipeline. Synthetic
// TouchEvents dispatched from page script do not drive Chrome's scrolling at
// all, so they would report a failure here whatever the page did.
const cdp = await ctx.newCDPSession(page)
const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] })
const dragged = await (async () => {
  const before = await page.evaluate(() =>
    document.querySelector('.scroll-thin.overflow-y-auto').scrollTop)
  await send('touchStart', target.x, target.y)
  for (let d = 12; d <= 200; d += 12) await send('touchMove', target.x, target.y - d)
  await send('touchEnd', target.x, target.y - 200)
  await wait(700)
  const after = await page.evaluate(() =>
    document.querySelector('.scroll-thin.overflow-y-auto').scrollTop)
  return { before, after }
})()
check('a touch drag below the pad scrolls it',
  dragged.after > dragged.before, `scrollTop ${dragged.before} -> ${dragged.after}`)

// ...and the other half of the same rule: a drag ON the pad is a pen
// stroke, and must not scroll the page out from under the writing. This is
// what the blanket preventDefault was there for in the first place.
const onPad = await page.evaluate(() => {
  const r = document.querySelector('.ink-surface').getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
await page.evaluate(() => {
  document.querySelector('.scroll-thin.overflow-y-auto').scrollTop = 40
})
const padBefore = await page.evaluate(() =>
  document.querySelector('.scroll-thin.overflow-y-auto').scrollTop)
await send('touchStart', onPad.x, onPad.y)
for (let d = 12; d <= 120; d += 12) await send('touchMove', onPad.x, onPad.y - d)
await send('touchEnd', onPad.x, onPad.y - 120)
await wait(600)
const padAfter = await page.evaluate(() =>
  document.querySelector('.scroll-thin.overflow-y-auto').scrollTop)
check('writing on the pad does not scroll the page',
  padAfter === padBefore, `scrollTop ${padBefore} -> ${padAfter}`)

// and programmatic scrolling, which is what scroll-into-view uses
const prog = await page.evaluate(async () => {
  const el = document.querySelector('.scroll-thin.overflow-y-auto')
  el.scrollTop = 99999
  await new Promise((r) => setTimeout(r, 200))
  return el.scrollTop
})
check('it can be scrolled to the bottom at all', prog > 4, `scrollTop ${prog}`)
check('no uncaught page errors', errs.length === 0, errs[0])

await page.screenshot({ path: resolve(ROOT, 'bench/shot-phone-scroll.png') })
console.log('  screenshot: bench/shot-phone-scroll.png')
await browser.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
