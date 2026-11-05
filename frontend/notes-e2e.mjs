// Prepared notes end to end: import a syllabus, have INKWISE write the notes,
// then highlight, write on and question them in a real browser.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const api = async (p, o = {}) => (await fetch(BASE + p, {
  headers: { 'Content-Type': 'application/json' }, ...o })).json()
let ok = true
const check = (name, cond, detail = '') => {
  ok &&= !!cond
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// a module with real syllabus material and questions to write notes from
const SUBJECT = `__notes_${Date.now().toString(36).slice(-4)}`
const MATERIAL = `Module 2: Process Management
Process concept and the process control block. Process states: new, ready,
running, waiting, terminated, and the transitions between them. Context
switching and its overhead. Threads and multithreading models. CPU scheduling:
FCFS, SJF, Shortest Remaining Time, Round Robin and priority scheduling, with
turnaround and waiting time.`
const commit = await api('/api/import/commit', { method: 'POST', body: JSON.stringify({
  subject_name: SUBJECT, filename: 'os-syllabus.txt', kind: 'syllabus', text: MATERIAL,
  modules: [{ name: 'Module 2: Process Management', notes: MATERIAL, questions: [
    { text: 'Explain the process state diagram.' },
    { text: 'What is a process control block?' },
    { text: 'Compare FCFS and Round Robin scheduling.' }] }] }) })
console.log('imported into subject', commit.subject_id)

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 1050 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('dialog', (d) => d.accept())
await page.goto(`${BASE}/?room=notese2e`, { waitUntil: 'networkidle0' })
await page.evaluate(() => document.fonts.ready)
const click = (txt, exact) => page.evaluate((t, ex) => {
  const b = [...document.querySelectorAll('button')].find((x) =>
    ex ? x.textContent.trim().toLowerCase() === t : x.textContent.includes(t))
  b?.click(); return !!b
}, txt, exact)

await click('notes', true)
await page.waitForFunction((s) => document.body.textContent.includes(s), { timeout: 15000 }, SUBJECT)
await click('Module 2: Process Management')
await sleep(600)
check('module with no notes offers to prepare them',
      await page.evaluate(() => document.body.textContent.includes('No notes for this module yet')))

const t0 = Date.now()
await click('Prepare notes')
await page.waitForFunction(() => document.querySelectorAll('.step-card').length > 0, { timeout: 420000 })
console.log(`   first ink after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
// wait for the sheet to settle into the annotatable two-column layout
await page.waitForFunction(() => !!document.querySelector('[data-section="0"]'), { timeout: 420000 })
await sleep(800)

const shape = await page.evaluate(() => {
  const secs = [...document.querySelectorAll('[data-section]')]
  return { sections: secs.length,
           titles: secs.slice(0, 6).map((s) => s.querySelector('header')?.textContent.trim()),
           diagrams: document.querySelectorAll('.ink-diagram').length,
           tables: document.querySelectorAll('.hand-table').length }
})
console.log('   notes:', JSON.stringify(shape))
check('notes written as several topic sections', shape.sections >= 3, `${shape.sections} sections`)
check('sections are named by topic, not "Step n"',
      shape.titles.every((t) => t && !/^Step \d/.test(t)), JSON.stringify(shape.titles.slice(0, 3)))
await page.evaluate(() => document.querySelector('[data-section="0"]').scrollIntoView({ block: 'start' }))
await sleep(300)
await page.screenshot({ path: '../bench/shot-notes-study.png' })

// --- select words: highlight, then ask ---------------------------------
const pickWords = async (n = 6) => page.evaluate((count) => {
  const body = document.querySelector('[data-section="0"] div.lined-text')
  const glyphs = [...body.querySelectorAll('span')].filter((s) => s.childElementCount === 0
    && s.textContent.length === 1 && !s.closest('.ink-math, .katex'))
  const sel = glyphs.slice(4, 4 + count)
  const r = document.createRange()
  r.setStartBefore(sel[0]); r.setEndAfter(sel[sel.length - 1])
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
  const b = r.getBoundingClientRect()
  return { text: sel.map((g) => g.textContent).join(''), x: b.x + b.width / 2, y: b.y + b.height / 2 }
}, n)
const words = await pickWords()
await page.mouse.move(words.x, words.y)
await page.mouse.down(); await page.mouse.up()           // fire mouseup on the section
await sleep(400)
check('selecting words offers Highlight / Explain / Ask',
      await page.evaluate(() => document.body.textContent.includes('Highlight')))
await click('Highlight')
await sleep(700)
const marks = await api(`/api/study-notes/${(await api('/api/study-notes/modules'))
  .find((s) => s.name === SUBJECT).modules[0].id}`)
check('highlight stored on the notes',
      marks.marks.some((m) => m.kind === 'highlight' && m.quote.replace(/\s/g, '')
        === words.text.replace(/\s/g, '')), JSON.stringify(marks.marks.map((m) => m.kind)))
check('highlight painted on screen',
      await page.evaluate(() => CSS.highlights.has('ink-highlight')))

// --- ask about the selection ------------------------------------------
await pickWords(10)
await page.mouse.move(words.x, words.y); await page.mouse.down(); await page.mouse.up()
await sleep(400)
await click('Explain')
await page.waitForFunction(() => document.querySelector('.border-l-4.border-amber-400'), { timeout: 20000 })
check('the question appears in the margin beside its section', true)
await page.waitForFunction(
  () => document.querySelectorAll('.border-l-4.border-amber-400 .step-card').length > 0,
  { timeout: 420000 })
// the explanation is stored when the stream ends, not when the first step shows
let stored = null
for (let i = 0; i < 300; i++) {
  stored = await api(`/api/study-notes/${marks.module.id}`)
  if (stored.marks.some((m) => m.kind === 'question' && (m.data || []).length > 0)) break
  await sleep(1000)
}
await sleep(1200)
await page.screenshot({ path: '../bench/shot-notes-margin.png' })
check('the explanation is kept with the notes',
      stored.marks.some((m) => m.kind === 'question' && (m.data || []).length > 0),
      JSON.stringify(stored.marks.map((m) => m.kind)))

// --- write on the notes ------------------------------------------------
await click('Write on the notes')
await sleep(300)
const sec = await page.evaluate(() => {
  const r = document.querySelector('[data-section="0"]').getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
await page.mouse.move(sec.x + sec.w * 0.55, sec.y + 30)
await page.mouse.down()
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(sec.x + sec.w * (0.55 + i * 0.02), sec.y + 30 + (i % 2 ? 8 : -6), { steps: 3 })
}
await page.mouse.up()
await sleep(900)
const withInk = await api(`/api/study-notes/${marks.module.id}`)
check('pen ink on the notes is kept',
      withInk.marks.some((m) => m.kind === 'ink' && (m.data || []).length > 0))

// --- survives a reload --------------------------------------------------
await page.reload({ waitUntil: 'networkidle0' })
await click('notes', true); await sleep(900)
await click('Module 2: Process Management'); await sleep(1500)
const after = await page.evaluate(() => ({
  highlight: CSS.highlights.has('ink-highlight'),
  ink: document.querySelectorAll('[data-section="0"] svg path').length,
  threads: document.querySelectorAll('.border-l-4.border-amber-400').length,
}))
check('highlights, ink and questions are still there after a reload',
      after.highlight && after.ink > 0 && after.threads > 0, JSON.stringify(after))
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '))

console.log(`\nNOTES E2E: ${ok ? 'PASS' : 'FAIL'}`)
await browser.close()
await fetch(`${BASE}/api/study/subjects/${commit.subject_id}`, { method: 'DELETE' })
process.exit(ok ? 0 : 1)
