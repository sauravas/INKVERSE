// Phase 2 end to end in a real browser:
// import a paper -> start the module -> answer by pen -> finish -> notes ->
// share link -> open it as a friend. Cleans up the subject it creates.
import puppeteer from 'puppeteer-core'
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const SUBJECT = `E2E Maths ${Date.now().toString(36)}`
const SHOTS = '../bench'
let ok = true
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  ok = ok && !!cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clickText = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button,a')].find((x) => x.textContent.includes(t))
  if (b) b.click()
  return !!b
}, text)

const dir = mkdtempSync(join(tmpdir(), 'inkwise-e2e-'))
const paper = join(dir, 'calculus-bank.txt')
writeFileSync(paper, `Module 1: Differentiation
Q1. Differentiate $4x^2 + 3x$ with respect to x. [2]
Q2. Find dy/dx if y = sin(x) cos(x). [3]
Q3. State the product rule.
`)

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Saurav' : undefined))
await page.goto(`${BASE}/?room=e2e${Date.now().toString(36).slice(-4)}`,
  { waitUntil: 'domcontentloaded' })

// ---- 1. import through the UI --------------------------------------------
await clickText(page, 'Import')
await sleep(500)
const input = await page.$('input[type=file]')
await input.uploadFile(paper)
await page.waitForFunction(() => document.body.innerText.includes('Save into'), { timeout: 60000 })
const qBoxes = await page.$$eval('textarea', (t) => t.map((x) => x.value).filter(Boolean))
check('preview shows the parsed questions for review', qBoxes.length >= 3, `${qBoxes.length} fields`)
await page.$eval('input[placeholder="Subject name"]', (el, v) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
}, SUBJECT)
await sleep(200)
await page.screenshot({ path: `${SHOTS}/shot-import.png` })
await clickText(page, 'Import 3 questions')
await page.waitForFunction(() => document.body.innerText.includes('Imported.'), { timeout: 30000 })
check('import saved', true)

// ---- 2. question bank: start the module ----------------------------------
await clickText(page, 'Go to the question bank')
await page.waitForFunction((s) => document.body.innerText.includes(s), { timeout: 15000 }, SUBJECT)
await page.evaluate((s) => {
  const sec = [...document.querySelectorAll('section')].find((x) => x.innerText.includes(s))
  ;[...sec.querySelectorAll('button')].find((b) => b.textContent.includes('Start module')).click()
}, SUBJECT)
await page.waitForFunction(() => document.body.innerText.includes('Your answer'), { timeout: 15000 })
await sleep(2500)   // let the pen finish writing the question
const qText = await page.$eval('.hand.block', (el) => el.textContent)
check('question is written onto the page', /Differentiate/.test(qText), JSON.stringify(qText.slice(0, 40)))
check('maths in the question is typeset', await page.$$eval('.katex', (k) => k.length) > 0)

// answer by pen
const cv = await page.$('canvas.ink-surface')
let b = await cv.boundingBox()
for (const y of [0.3, 0.6]) {
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(b.x + b.width * (0.1 + i * 0.07),
      b.y + b.height * (y + (i % 2 ? 0.05 : -0.04)), { steps: 6 })
  }
  await page.mouse.up()
  await sleep(150)
}
await page.screenshot({ path: `${SHOTS}/shot-practice.png` })

// finish: done -> I knew it
await clickText(page, 'Done — next question')
await sleep(300)
await clickText(page, 'I knew it')
await page.waitForFunction(() => document.body.textContent.includes('Question 2'), { timeout: 15000 })
check('moves on to question 2 after finishing', true)

// ---- 3. check the stored attempt and progress over the API ---------------
const subj = (await (await fetch(`${BASE}/api/study/subjects`)).json()).find((s) => s.name === SUBJECT)
const mod = subj.modules[0]
const sess = await (await fetch(`${BASE}/api/practice/module/${mod.id}`)).json()
const q1 = sess.questions[0]
const det = await (await fetch(`${BASE}/api/practice/question/${q1.id}`)).json()
check('handwritten answer stored with the question',
  det.attempt?.strokes?.length === 2 && det.attempt?.image?.startsWith('data:image/png'),
  `${det.attempt?.strokes?.length} strokes`)
check('outcome recorded and progress advanced by rule',
  q1.outcome === 'knew' && q1.status === 'studied' && q1.recall_correct === 1,
  `${q1.outcome}/${q1.status}`)

// ---- 4. notes, then share --------------------------------------------------
await clickText(page, 'My answers')
await page.waitForFunction(() => document.body.innerText.includes('My answer'), { timeout: 15000 })
check('notes show the student\'s handwritten answer',
  await page.$$eval('img[alt="handwritten answer"]', (i) => i.length) === 1)
await page.screenshot({ path: `${SHOTS}/shot-notes.png` })

await clickText(page, 'Share with friends')
await page.waitForFunction(() => document.querySelector('input[readonly]')?.value.includes('/notes/'),
  { timeout: 15000 })
const shareUrl = await page.$eval('input[readonly]', (i) => i.value)
check('share dialog gives a LAN link with a QR code',
  /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/notes\//.test(shareUrl)
  && await page.$$eval('.fixed svg', (s) => s.length) === 1, shareUrl)
await page.screenshot({ path: `${SHOTS}/shot-share.png` })

// ---- 5. a friend opens the link ------------------------------------------
const friend = await browser.newPage()
await friend.setViewport({ width: 1100, height: 900 })
friend.on('pageerror', (e) => errs.push('friend: ' + String(e)))
const token = shareUrl.split('/notes/')[1]
await friend.goto(`${BASE}/notes/${token}`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 1200))
await friend.waitForFunction(() => document.body.innerText.includes('Differentiation'), { timeout: 15000 })
check('friend sees the notes read-only',
  await friend.evaluate(() => document.body.innerText.includes('Download to my INKWISE')
    && !document.body.innerText.includes('Share with friends')))
await friend.screenshot({ path: `${SHOTS}/shot-shared.png` })
const bundle = await (await fetch(`${BASE}/api/share/${token}/bundle`)).json()
check('friend can download the notes file', bundle.inkwise_bundle === 1
  && bundle.modules[0].questions.length === 3)

// ---- clean up --------------------------------------------------------------
await fetch(`${BASE}/api/study/subjects/${subj.id}`, { method: 'DELETE' })
for (const s of await (await fetch(`${BASE}/api/import/sources`)).json()) {
  if (s.subject_id === subj.id || s.filename === 'calculus-bank.txt') {
    await fetch(`${BASE}/api/import/sources/${s.id}`, { method: 'DELETE' })
  }
}
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '))
console.log(`\nPHASE 2 E2E: ${ok ? 'PASS' : 'FAIL'}`)
await browser.close()
process.exit(ok ? 0 : 1)
