/**
 * The phone is a client, not a pen: it can ask, and both devices get the answer.
 *
 * The workspace was already shared - same pages, same strokes - but the answer
 * was not: it appeared only on the screen that pressed Solve. This drives a
 * phone and a laptop in the same room at the same time and checks that an
 * answer asked for on one is written on both, live.
 *
 *   node frontend\two-device-e2e.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const window_h = 900
const ROOM = `two${Math.random().toString(36).slice(2, 6)}`

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}
const textOf = (p) => p.evaluate(() => document.body.innerText)

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext()
const errs = []
ctx.on('page', (pg) => pg.on('pageerror', (e) => errs.push(String(e))))

const laptop = await ctx.newPage()
await laptop.setViewportSize({ width: 1400, height: 950 })
await laptop.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'domcontentloaded' })

const phone = await ctx.newPage()
await phone.setViewportSize({ width: 412, height: 900 })
await phone.goto(`${BASE}/phone?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
await phone.waitForTimeout(2500)

const phoneText = await textOf(phone)
check('the phone joins the laptop workspace', /laptop connected/i.test(phoneText),
  phoneText.slice(0, 120))
check('the phone can type a question',
  (await phone.locator('textarea, input[type=text]').count()) > 0)

// --- the phone asks -------------------------------------------------------
console.log('  … the phone asks a question')
const asked = await phone.evaluate(() => {
  const el = document.querySelector('textarea, input[type="text"]')
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set
    .call(el, 'Differentiate 4x^2 + 3x with respect to x')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})
check('the question was submitted from the phone', asked)

// the laptop should pick the question up over the socket, before any answer
await laptop.waitForFunction(
  () => /Differentiate/.test(document.body.innerText), null, { timeout: 30000 })
  .then(() => check('the laptop shows the question the phone asked', true))
  .catch(() => check('the laptop shows the question the phone asked', false,
                     'never appeared'))

// then both should fill with the same answer
const waitForAnswer = (p, who) => p.waitForFunction(
  () => (document.querySelectorAll('[data-step-index]').length > 0),
  null, { timeout: 240000 })
  .then(() => true).catch(() => false)

const [onPhone, onLaptop] = await Promise.all([
  waitForAnswer(phone, 'phone'), waitForAnswer(laptop, 'laptop')])
check('the answer is written on the phone', onPhone)
check('and on the laptop at the same time', onLaptop)

// both write the answer at a readable pace, so compare once they have
// stopped rather than mid-sentence
const settle = async () => {
  let last = [-1, -1]
  for (let i = 0; i < 60; i++) {
    const now = [await phone.locator('[data-step-index]').count(),
                 await laptop.locator('[data-step-index]').count()]
    if (now[0] === last[0] && now[1] === last[1] && now[0] > 0) return now
    last = now
    await phone.waitForTimeout(1500)
  }
  return last
}
const [pSteps, lSteps] = await settle()
check('both devices end up with the same answer', pSteps === lSteps && pSteps > 0,
  `phone ${pSteps}, laptop ${lSteps}`)

const pText = await textOf(phone)
check('the phone renders the answer, not raw markers',
  !pText.includes('@@STEP') && !pText.includes('\\frac'))
check('no uncaught page errors', errs.length === 0, errs[0])

// the answer must be reachable without scrolling past a blank pad
const visible = await phone.evaluate(() => {
  const a = document.querySelector('[data-step-index]')
  if (!a) return -1
  const r = a.getBoundingClientRect()
  return Math.round(r.top)
})
check('the answer is on screen, not buried below the pad',
  visible >= 0 && visible < window_h, 'top at ' + visible + 'px')
await phone.screenshot({ path: '../bench/two-phone.png' })
await laptop.screenshot({ path: '../bench/two-laptop.png' })
await browser.close()

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
