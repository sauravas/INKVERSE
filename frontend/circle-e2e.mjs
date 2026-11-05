// Circle to ask, in a real browser: draw loops with the mouse and check what
// INKWISE thinks was circled. Seeds a throwaway answer and removes it after.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const api = async (path, opts = {}) => (await fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json' }, ...opts })).json()

const diagram = JSON.parse(execFileSync('../.venv/Scripts/python.exe', ['-c', `
import sys, json; sys.path.insert(0, '../backend')
from app.ai.diagram import parse_edge_list
print(json.dumps(parse_edge_list("Process states", ["direction: LR", "New -> Ready : admitted",
  "Ready -> Running : dispatch", "Running -> Waiting : I/O", "Waiting -> Ready : done"])))`]).toString())
const t = (v) => ({ kind: 'text', value: v, display: false })
const steps = [
  { index: 1, title: 'Set up', final: false, segments: [
    t('We integrate by parts using '), { kind: 'math', value: 'u = x^2', display: false },
    t(' and the remaining terms simplify nicely.\n') ] },
  { index: 2, title: 'The states', final: false, segments: [
    t('A process moves between these states:\n'),
    { kind: 'diagram', value: diagram.title, display: true, diagram } ] },
]
const sub = await api('/api/study/subjects', { method: 'POST', body: JSON.stringify({ name: '__circle' }) })
await api('/api/study/questions', { method: 'POST', body: JSON.stringify({
  subject_id: sub.id, text: 'Circle test', answer_json: JSON.stringify(steps) }) })

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1100 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?room=circlee2e`, { waitUntil: 'networkidle0' })
await page.evaluate(() => document.fonts.ready)
const click = (txt, exact) => page.evaluate((x, ex) => {
  const b = [...document.querySelectorAll('button')].find((b2) =>
    ex ? b2.textContent.trim().toLowerCase() === x : b2.textContent.includes(x))
  b?.click(); return !!b
}, txt, exact)
await click('dashboard', true); await new Promise((r) => setTimeout(r, 900))
await click('__circle'); await new Promise((r) => setTimeout(r, 700))
await click('Circle test'); await new Promise((r) => setTimeout(r, 1800))
await page.evaluate(() => document.querySelector('[data-answer-start]').scrollIntoView({ block: 'start' }))
await new Promise((r) => setTimeout(r, 400))

/** Draw a closed loop around a box (an ellipse of points through the mouse). */
async function loopAround(box, pad = 10) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const rx = box.width / 2 + pad
  const ry = box.height / 2 + pad
  await page.mouse.move(cx + rx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 36; i++) {
    const a = (i / 36) * 2 * Math.PI
    await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a))
  }
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 300))
}
const askedAbout = () => page.evaluate(() => {
  const p = [...document.querySelectorAll('p')].find((x) => x.textContent.startsWith('You circled'))
  const box = p?.closest('.ml-6')
  const stepCard = box?.previousElementSibling
  return p ? { text: p.textContent, step: stepCard?.dataset.stepIndex } : null
})
const rect = (sel, fn) => page.evaluate((s, f) => {
  const el = [...document.querySelectorAll(s)].find(new Function('el', `return ${f}`))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}, sel, fn || 'true')
const cancelAsk = () => click('cancel')
let ok = true
const check = (name, cond, detail) => {
  ok &&= !!cond
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// 1. a diagram block
await click('Circle to ask')
await loopAround(await rect('[data-block]', 'el.dataset.block === "Running"'), 14)
let got = await askedAbout()
check('circling a diagram block names that block', got?.text.includes('"Running"') && got.step === '2',
      JSON.stringify(got))
await page.screenshot({ path: '../bench/shot-circle.png' })
await cancelAsk()

// 2. a formula
await click('Circle to ask')
await loopAround(await rect('[data-tex]', 'el.dataset.tex === "u = x^2"'), 12)
got = await askedAbout()
check('circling a formula names only that formula',
      /u\s*=\s*x/.test(got?.text || '') && !/words/.test(got?.text || '') && got.step === '1',
      JSON.stringify(got))
await cancelAsk()

// 3. a few handwritten words
const words = await page.evaluate(() => {
  // the step body, not the "Step 1" header (which is also .lined-text)
  const body = document.querySelector('[data-step-index="1"] > div.lined-text')
  const glyphs = [...body.querySelectorAll('span')].filter((s) => s.childElementCount === 0
    && s.textContent.length === 1 && !s.closest('.ink-math'))
  // the glyphs spelling "simplify"
  const text = glyphs.map((g) => g.textContent).join('')
  const at = text.indexOf('simplify')
  const sel = glyphs.slice(at, at + 8).map((g) => g.getBoundingClientRect())
  const x = Math.min(...sel.map((r) => r.left))
  const y = Math.min(...sel.map((r) => r.top))
  return { x, y, width: Math.max(...sel.map((r) => r.right)) - x, height: Math.max(...sel.map((r) => r.bottom)) - y }
})
await click('Circle to ask')
await loopAround(words, 8)
got = await askedAbout()
check('circling handwritten words reads them back', /simplify/.test(got?.text || ''), JSON.stringify(got))
await cancelAsk()

// 4. empty paper
await click('Circle to ask')
// blank paper inside the answer, to the right of step 1's short sentence
const body = await rect('[data-step-index="1"] > div.lined-text')
await loopAround({ x: body.x + body.width - 110, y: body.y + 4, width: 60, height: 16 }, 6)
const missed = await page.evaluate(() => document.body.textContent.includes('nothing inside that loop'))
check('a loop around nothing says so', missed && !(await askedAbout()))

check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '))
console.log(`\nCIRCLE E2E: ${ok ? 'PASS' : 'FAIL'}`)
await browser.close()
await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })
process.exit(ok ? 0 : 1)
