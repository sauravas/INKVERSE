/**
 * An import must be real, and it must show up without being chased.
 *
 * The reported symptom was that imports looked like a mock: the question bank
 * the student uploaded produced a module named after its own first question
 * and no questions at all, and nothing changed anywhere else in the app. This
 * drives the whole path in a browser - upload, review, save - and then checks
 * the dashboard and the notes list, which are open in a *second tab* and are
 * never reloaded. If the live signal does not reach them, this fails.
 *
 *   node frontend\import-live.mjs
 */
import puppeteer from 'puppeteer-core'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const SUBJECT = `__imp ${Math.random().toString(36).slice(2, 7)}`
const FILE = `${process.env.TEMP || '.'}\\${SUBJECT.replace(/\W/g, '')}.txt`

// the shape that failed: a heading, then unnumbered questions, one per line
writeFileSync(FILE, `DSP QUESTION BANK
MODULE-1
Discuss the process of frequency domain sampling of discrete time signals.
Show that DFT is a linear transformation.
Compute 4 point DFT using the formula method for x(n) = {1, 2, 3, 4}.
Compute 4 point IDFT for X(k) = {6, -2+2j, -2, -2-2j}.
Derive the relationship of DFT with Z transforms.
State and prove the circular convolution property of DFT.
`)

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         protocolTimeout: 120000,
                                         args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
const click = (p, txt, exact) => p.evaluate((x, ex) => {
  const b = [...document.querySelectorAll('button')].find((e) =>
    ex ? e.textContent.trim().toLowerCase() === x : e.textContent.includes(x))
  b?.click(); return !!b
}, txt, exact)

await page.goto(`${BASE}/?room=implive`, { waitUntil: 'domcontentloaded' })
await wait(1500)

// a second tab, left on the dashboard, never reloaded from here on
const watcher = await browser.newPage()
await watcher.setViewport({ width: 1200, height: 900 })
await watcher.goto(`${BASE}/?room=implive`, { waitUntil: 'domcontentloaded' })
await wait(1500)
await click(watcher, 'dashboard', true)
await wait(1200)
const before = await watcher.evaluate(() => document.body.innerText)
check('the watching tab does not have the subject yet', !before.includes(SUBJECT))

// --- import -------------------------------------------------------------
await click(page, 'import', true)
await wait(900)
const input = await page.$('input[type=file]')
check('the import screen offers a file picker', !!input)
await input.uploadFile(FILE)
await wait(4000)

const preview = await page.evaluate(() => document.body.innerText)
check('the document was read', !preview.includes('Drop a file here'), preview.slice(0, 120))
check('questions were found, not notes', /\b[5-9]\b[\s\S]{0,40}question/i.test(preview)
  || preview.includes('Discuss the process'), preview.slice(0, 300))
check('the module is not named after a question',
  !/Module 1: Discuss/i.test(preview))

// name the subject so it is findable, then save
// set it the way React sees it: the native setter, then an input event
const named = await page.evaluate((name) => {
  const el = document.querySelector('input[placeholder="Subject name"]')
  if (!el) return false
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set
  set.call(el, name)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, SUBJECT)
check('a new subject can be named', named)
await wait(400)
// the save button names what it will do: "Import 6 questions into 1 module"
const saved = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .find((e) => /^Import \d+ question/.test(e.textContent.trim()))
  if (!b || b.disabled) return b ? 'disabled' : 'missing'
  b.click(); return b.textContent.trim()
})
check('the import button offers the questions it found',
  /^Import [5-9]\d* question/.test(String(saved)), String(saved))
await wait(3000)

const done = await page.evaluate(() => document.body.innerText)
check('the import saved', done.includes('Imported'), done.slice(0, 200))
const created = Number((done.match(/(\d+)\s+new question/) || [])[1] ?? -1)
check('it created real questions', created >= 5, `created=${created}`)

// --- did it reach the rest of the app, without a reload? ----------------
await wait(1500)
const after = await watcher.evaluate(() => document.body.innerText)
check('the watching dashboard picked it up live', after.includes(SUBJECT),
  'subject never appeared on the other tab')

await click(watcher, 'notes', true)
await wait(1500)
const notes = await watcher.evaluate(() => document.body.innerText)
check('the module is offered in Notes', notes.includes('Module 1')
  || notes.includes(SUBJECT), notes.slice(0, 200))

await click(page, 'Go to the question bank')
await wait(1500)
const bank = await page.evaluate(() => document.body.innerText)
check('the question bank lists it', bank.includes(SUBJECT), bank.slice(0, 200))

check('no uncaught page errors', errs.length === 0, errs[0])

// --- the data really is in the database ---------------------------------
const subjects = await (await fetch(`${BASE}/api/study/subjects`)).json()
const sub = subjects.find((s) => s.name === SUBJECT)
check('the subject is stored', !!sub)
if (sub) {
  check('its questions are stored', sub.question_count >= 5, `${sub?.question_count}`)
  check('its module is named from the heading',
    sub.modules.some((m) => /^Module 1$/i.test(m.name)),
    JSON.stringify(sub.modules.map((m) => m.name)))
  await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })
}

await browser.close()
try { unlinkSync(FILE) } catch { /* already gone */ }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
