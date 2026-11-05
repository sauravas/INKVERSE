/**
 * Import a real (scanned) PDF, and prove every other module notices.
 *
 * The complaint behind this test was that import, the question bank, the notes
 * list and the dashboard behaved like mocks: a screen showed whatever it had
 * fetched when it mounted, so an import was invisible everywhere else until
 * you navigated away and came back.
 *
 * So the checks here are deliberately awkward: a second browser tab is opened
 * first, parked on a screen, and NEVER reloaded or re-navigated. If anything
 * only works because a view remounted, it fails here.
 *
 *   .venv\\Scripts\\python.exe bench\\make_qb_pdf.py     # once
 *   node frontend\\realtime-e2e.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PDF = resolve(HERE, '../bench/sample-qb.pdf')
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const SUBJECT = `DSP realtime ${Math.random().toString(36).slice(2, 6)}`

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}
const api = async (p, o = {}) => (await fetch(BASE + p, {
  headers: { 'Content-Type': 'application/json' }, ...o })).json()

if (!existsSync(PDF)) {
  console.error(`missing ${PDF} - run: .venv\\Scripts\\python.exe bench\\make_qb_pdf.py`)
  process.exit(2)
}

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const errs = []
ctx.on('page', (pg) => pg.on('pageerror', (e) => errs.push(String(e))))

const go = async (page, view) => {
  await page.getByRole('button', { name: view, exact: true }).click()
  await page.waitForTimeout(900)
}

// --- the watcher: opened before anything exists, never navigated again -----
const watcher = await ctx.newPage()
await watcher.goto(`${BASE}/?room=rt`, { waitUntil: 'domcontentloaded' })
await watcher.waitForTimeout(1800)
await go(watcher, 'Dashboard')
check('watcher starts without the subject',
  !(await watcher.locator('body').innerText()).includes(SUBJECT))

// --- a second watcher parked on the question bank --------------------------
const bankTab = await ctx.newPage()
await bankTab.goto(`${BASE}/?room=rt`, { waitUntil: 'domcontentloaded' })
await bankTab.waitForTimeout(1800)
await go(bankTab, 'Question bank')

// --- a third parked on notes ----------------------------------------------
const notesTab = await ctx.newPage()
await notesTab.goto(`${BASE}/?room=rt`, { waitUntil: 'domcontentloaded' })
await notesTab.waitForTimeout(1800)
await go(notesTab, 'Notes')

// --- the student imports the PDF -------------------------------------------
const page = await ctx.newPage()
await page.goto(`${BASE}/?room=rt`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1800)
await go(page, 'Import')

check('OCR is available for scanned pages',
  (await page.locator('body').innerText()).toLowerCase().includes('tesseract'))

await page.locator('input[type=file]').setInputFiles(PDF)
console.log('  … reading the PDF (2 scanned pages through OCR)')
await page.waitForFunction(
  () => !document.body.innerText.includes('Reading the document'),
  null, { timeout: 180000 })
await page.waitForTimeout(800)

const preview = await page.locator('body').innerText()
// module names are editable inputs in the review step, so their text is in
// the value, not in innerText
const moduleNames = await page.locator('input').evaluateAll(
  (els) => els.map((e) => e.value).filter((v) => /^Module/i.test(v)))
check('both modules were recognised',
  moduleNames.some((n) => /Module 2/i.test(n))
  && moduleNames.some((n) => /Module 3/i.test(n)), JSON.stringify(moduleNames))
const qFields = await page.locator('textarea').count()
check('every question is offered for review', qFields >= 13, `${qFields} fields`)
check('the OCR method is reported', /OCR|tesseract/i.test(preview))

await page.fill('input[placeholder="Subject name"]', SUBJECT)
const importBtn = page.getByRole('button', { name: /^Import \d+ question/ })
check('the save button counts what it found',
  /Import 1[0-9] question/.test(await importBtn.innerText()),
  await importBtn.innerText())
await importBtn.click()
await page.waitForTimeout(3500)
check('it saved', (await page.locator('body').innerText()).includes('Imported'))

// --- did the other three tabs notice, without being touched? ---------------
await watcher.waitForTimeout(1200)
const dash = await watcher.locator('body').innerText()
check('DASHBOARD updated live', dash.includes(SUBJECT), 'subject never appeared')
check('dashboard counted the questions', /1[0-9] questions/.test(dash))

const bank = await bankTab.locator('body').innerText()
check('QUESTION BANK updated live', bank.includes(SUBJECT), 'subject never appeared')

const notes = await notesTab.locator('body').innerText()
check('NOTES updated live', /Module 2/.test(notes) && /Module 3/.test(notes),
  notes.slice(0, 200))

// --- the question bank can actually start the module -----------------------
// "Start module" sits on the module row; the imported subject is already in
// this tab's list because it updated live a moment ago.
const startBtn = bankTab.getByRole('button', { name: 'Start module' }).first()
const started = await startBtn.click({ timeout: 8000 }).then(() => true)
  .catch(() => false)
check('the imported module offers Start module', started)
if (started) {
  await bankTab.waitForTimeout(2500)
  const session = await bankTab.locator('body').innerText()
  check('starting it writes the first question onto the page',
    /overlap|derive|compute|explain|design|realise/i.test(
      session.replace(/^[\s\S]*?Question bank/, '')),
    session.slice(0, 300))
}

// --- removing the import is live too ---------------------------------------
const subjects = await api('/api/study/subjects')
const sub = subjects.find((s) => s.name === SUBJECT)
check('stored in the database', !!sub)
if (sub) {
  check('with all its questions', sub.question_count >= 13, `${sub?.question_count}`)
  check('in two modules named from the headings',
    sub.modules.filter((m) => /^Module [23]$/.test(m.name)).length === 2,
    JSON.stringify(sub.modules.map((m) => m.name)))
}

const sources = await api('/api/import/sources')
const src = sources.find((s) => (s.filename || '').includes('sample-qb'))
check('the import is listed on the import screen', !!src)
if (src) {
  await api(`/api/import/sources/${src.id}?with_questions=true`, { method: 'DELETE' })
  await watcher.waitForTimeout(1500)
  const after = await watcher.locator('body').innerText()
  check('DASHBOARD reflects the removal live',
    !/1[0-9] questions/.test(after.split(SUBJECT)[1]?.slice(0, 120) || ''),
    'questions still counted after the import was removed')
}

check('no uncaught page errors', errs.length === 0, errs[0])

await watcher.screenshot({ path: '../bench/realtime-dashboard.png' })
await browser.close()
if (sub) await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
