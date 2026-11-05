/**
 * The answer sheet must never show raw LaTeX source.
 *
 * Reproduces the page from the bug report: the model wrote an algorithm as
 * mathematics, KaTeX could not parse `next_node`, and with throwOnError:false
 * it rendered the source itself in red. The answer is stored and then opened
 * from the dashboard, which is the path a saved answer actually takes - the
 * broken page was a saved one, so repairing it only on the way in would not
 * have helped.
 *
 *   node frontend\latex-check.mjs
 */
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const api = async (path, opts = {}) => (await fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json' }, ...opts })).json()

// exactly the shape that produced the red page
const CODE_AS_MATH =
  '\\text{def bfs(graph, start):}\\\\ \\quad \\text{queue = [start]}\\\\ '
  + '\\quad \\text{while queue:}\\\\ \\qquad \\text{next_node = queue.pop(0)}'

const t = (v) => ({ kind: 'text', value: v, display: false })
const steps = [
  { index: 1, title: 'Algorithm', final: false, segments: [
    t('The traversal is written below.\n'),
    { kind: 'math', value: CODE_AS_MATH, display: true }] },
  { index: 2, title: 'Complexity', final: false, segments: [
    t('Each edge is seen once, so '),
    { kind: 'math', value: 'O(V + E)', display: false },
    t(' overall.\n'),
    { kind: 'math', value: '\\frac{d}{dx}\\left(4x^2\\right) = 8x', display: true }] },
  { index: 3, title: 'Not maths at all', final: false, segments: [
    { kind: 'math', value: '\\frac{\\alpha}{\\beta \\badmacro{x}} \\times', display: true }] },
  { index: 4, title: 'Done', final: true, segments: [
    t('A real code block, as the model is now asked to write them:\n'),
    { kind: 'code', value: 'python', display: true, code: { language: 'python',
      text: 'def bfs(graph, start):\n    queue = [start]\n    while queue:\n'
          + '        next_node = queue.pop(0)\n        print(next_node)' } }] },
]

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}

const sub = await api('/api/study/subjects', {
  method: 'POST', body: JSON.stringify({ name: '__latex' }) })
await api('/api/study/questions', { method: 'POST', body: JSON.stringify({
  subject_id: sub.id, text: 'Write breadth-first search and give its complexity',
  answer_json: JSON.stringify(steps) }) })

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1100 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
const click = (txt, exact) => page.evaluate((x, ex) => {
  const b = [...document.querySelectorAll('button')].find((e) =>
    ex ? e.textContent.trim().toLowerCase() === x : e.textContent.includes(x))
  b?.click(); return !!b
}, txt, exact)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto(`${BASE}/?room=latexcheck`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => document.fonts.ready)
await click('dashboard', true); await wait(900)
await click('__latex'); await wait(700)
await click('Write breadth-first'); await wait(3000)

// Scope every text assertion to the answer itself. The agent log in the
// margin replays recent runs verbatim, so a solve from earlier in the session
// can legitimately put LaTeX on the page outside the answer sheet.
const body = await page.evaluate(() => {
  const sheet = document.querySelector('[data-answer-start]')?.closest('div')
    ?.parentElement || document.querySelector('.ruled') || document.body
  return sheet.innerText
})
const html = await page.evaluate(() => {
  const sheet = document.querySelector('.ruled') || document.body
  return sheet.innerHTML
})

check('no KaTeX error markup on the page', !html.includes('katex-error'))
check('no raw \\text{ on the page', !body.includes('\\text{'))
check('no raw \\quad on the page', !body.includes('\\quad'))
check('no stray backslash-macros on the page', !/\\[a-zA-Z]{3,}/.test(body),
  (body.match(/\\[a-zA-Z]{3,}/) || [])[0])
check('the algorithm is readable as code', body.includes('def bfs(graph, start):'))
check('the underscore identifier survived', body.includes('next_node'))
check('indentation survived', body.includes('    queue = [start]'))
check('correct maths still renders as maths',
  (await page.$$('.ink-math .katex')).length >= 2)
check('the unparseable formula degraded to words',
  (await page.$$('.ink-math-plain')).length === 1)
check('the real code block rendered', (await page.$$('pre code')).length >= 1)
check('no uncaught page errors', errs.length === 0, errs[0])

const card = await page.$('[data-step-index="1"]')
if (card) {
  await card.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await wait(300)
  await page.screenshot({ path: '../bench/shot-latex.png', fullPage: true })
  console.log('  screenshot: bench/shot-latex.png')
}
await browser.close()
await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
