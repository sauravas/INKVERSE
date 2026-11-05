// Does everything on the page sit on the ruled lines?
// Seeds an answer with paragraphs, inline fractions, display maths and a
// diagram, opens it, types a question, then checks every block's top and
// height are whole multiples of one rule, relative to the sheet.
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
print(json.dumps(parse_edge_list("Integration by parts", [
  "direction: LR", "Choose u -> Differentiate u : du", "Choose dv -> Integrate dv : v",
  "Differentiate u -> Apply formula", "Integrate dv -> Apply formula"])))`]).toString())
const t = (v) => ({ kind: 'text', value: v, display: false })
const m = (v, display = false) => ({ kind: 'math', value: v, display })
const steps = [
  { index: 1, title: 'Set up', final: false, segments: [
    t('We use '), m('\\int u\\,dv = uv - \\int v\\,du'), t(' with '), m('u = x^2'), t('.\n'),
    t('So '), m('du = 2x\\,dx'), t(' and '), m('v = \\tfrac{1}{3}e^{3x}'), t(' - a fraction inline.\n'),
    { kind: 'break', value: '', display: false },
    m('I = \\frac{x^2 e^{3x}}{3} - \\frac{2}{3}\\int x e^{3x}\\,dx', true),
    t('The remaining integral is simpler.\n') ] },
  { index: 2, title: 'The plan', final: false, segments: [
    t('The method in one picture:\n'),
    { kind: 'diagram', value: diagram.title, display: true, diagram },
    t('Each arrow is one move.\n') ] },
  { index: 3, title: 'Final answer', final: true, segments: [
    m('I = \\frac{e^{3x}}{27}\\left(9x^2 - 6x + 2\\right) + C', true) ] },
]
const sub = await api('/api/study/subjects', { method: 'POST', body: JSON.stringify({ name: '__lines_check' }) })
await api('/api/study/questions', { method: 'POST', body: JSON.stringify({
  subject_id: sub.id, text: 'Evaluate $\\int x^2 e^{3x}\\,dx$', answer_json: JSON.stringify(steps) }) })

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1100 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?room=linescheck`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => document.fonts.ready)
const click = (txt, exact) => page.evaluate((t, ex) => {
  const b = [...document.querySelectorAll('button')].find((x) =>
    ex ? x.textContent.trim().toLowerCase() === t : x.textContent.includes(t))
  b?.click(); return !!b
}, txt, exact)
await click('dashboard', true); await new Promise((r) => setTimeout(r, 900))
await click('__lines_check'); await new Promise((r) => setTimeout(r, 700))
await click('Evaluate'); await new Promise((r) => setTimeout(r, 1800))

// type a two-line question into the page
await page.click('textarea.lined-input')
await page.keyboard.type('What is the derivative of x^2 sin x, and why do we need the product rule here?')
await new Promise((r) => setTimeout(r, 300))

const report = await page.evaluate(() => {
  const sheet = document.querySelector('.ruled')
  const R = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2
  const top0 = sheet.getBoundingClientRect().top
  const pick = [
    ['canvas', 'canvas.ink-surface'], ['typed line', 'textarea.lined-input'],
    ['answer header', '[data-answer-start] > .lined-row'], ['step header', '.step-card header'],
    ['step body', '.step-card > div.lined-text'], ['display maths', '.step-card .flex.flex-col.justify-center'],
    ['diagram', '.ink-diagram'],
  ]
  const rows = []
  for (const [name, sel] of pick) {
    for (const el of sheet.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      const top = r.top - top0
      const offTop = Math.min(top % R, R - (top % R))
      const offH = Math.min(r.height % R, R - (r.height % R))
      rows.push({ name, top: +top.toFixed(1), height: +r.height.toFixed(1),
                  ok: offTop < 0.75 && offH < 0.75 })
    }
  }
  return { R, lines: window.__lines, rows }
})
console.log(`rule = ${report.R}px; calibration:`, JSON.stringify(report.lines))
let bad = 0
for (const r of report.rows) {
  if (!r.ok) bad++
  console.log(`${r.ok ? 'ON ' : 'OFF'}  ${r.name.padEnd(14)} top ${String(r.top).padStart(7)}  height ${r.height}`)
}
await page.evaluate(() => document.querySelector('.step-card')?.scrollIntoView({ block: 'start' }))
await new Promise((r) => setTimeout(r, 400))
const clip = await page.evaluate(() => {
  const r = document.querySelector('.ruled').getBoundingClientRect()
  return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(980, innerHeight - Math.max(0, r.y)) }
})
await page.screenshot({ path: '../bench/shot-lines.png', clip })
console.log(`\n${report.rows.length - bad}/${report.rows.length} blocks on the rules; errors: ${errs.length ? errs : 'none'}`)
await browser.close()
await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })
process.exit(bad ? 1 : 0)
