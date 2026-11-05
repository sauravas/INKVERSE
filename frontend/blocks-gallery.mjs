// Every diagram kind plus a table in one answer: render, check the rules, screenshot.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const api = async (path, opts = {}) => (await fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json' }, ...opts })).json()

// real backend parsing, so these are exactly what a model answer would produce
const built = JSON.parse(execFileSync('../.venv/Scripts/python.exe', ['-c', `
import sys, json; sys.path.insert(0, '../backend')
from app.ai.diagram import parse_edge_list
from app.ai.parser import parse_table
d = lambda t, l: parse_edge_list(t, l)
print(json.dumps({
 "flow": d("Is n prime?", ["direction: TB", "Start -> Read n", "Read n -> D{n > 1?}",
   "D -> Check divisors to sqrt n : yes", "D -> Not prime : no",
   "Check divisors to sqrt n -> F{Divisor found?}", "F -> Not prime : yes", "F -> Prime : no",
   "Prime -> End", "Not prime -> End"]),
 "cycle": d("PDCA cycle", ["Plan -> Do : run it", "Do -> Check : measure", "Check -> Act : adjust", "Act -> Plan"]),
 "labelled": d("Parts of a CPU", ["CPU -> ALU : arithmetic and logic", "CPU -> Control Unit : decodes instructions",
   "CPU -> Registers : fastest storage", "CPU -> Cache : recent data", "CPU -> Bus Interface : talks to memory"]),
 "tree": d("Memory hierarchy", ["direction: TB", "Memory -> Primary", "Memory -> Secondary",
   "Primary -> RAM", "Primary -> Cache", "Secondary -> SSD", "Secondary -> HDD"]),
 "table": parse_table(["| Aspect | Process | Thread |", "|---|---|---|",
   "| Memory | Separate address space | Shared with its process |",
   "| Creation cost | High | Low, about $10\\\\times$ cheaper |",
   "| Isolation | A crash stays inside | One crash can take all down |"]),
}))`]).toString())
for (const k of ['flow', 'cycle', 'labelled', 'tree']) console.log(k.padEnd(9), '->', built[k].kind)

const t = (v) => ({ kind: 'text', value: v, display: false })
const dg = (x) => ({ kind: 'diagram', value: x.title, display: true, diagram: x })
const steps = [
  { index: 1, title: 'Flowchart', final: false, segments: [t('An algorithm:\n'), dg(built.flow)] },
  { index: 2, title: 'Cycle', final: false, segments: [t('A repeating process:\n'), dg(built.cycle)] },
  { index: 3, title: 'Labelled figure', final: false, segments: [t('The parts of one thing:\n'), dg(built.labelled)] },
  { index: 4, title: 'Hierarchy', final: false, segments: [t('A tree:\n'), dg(built.tree)] },
  { index: 5, title: 'Comparison', final: false, segments: [t('Side by side:\n'),
    { kind: 'table', value: '', display: true, table: built.table }, t('Threads are lighter, processes safer.\n')] },
]
const sub = await api('/api/study/subjects', { method: 'POST', body: JSON.stringify({ name: '__gallery' }) })
await api('/api/study/questions', { method: 'POST', body: JSON.stringify({
  subject_id: sub.id, text: 'Gallery of answer blocks', answer_json: JSON.stringify(steps) }) })

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?room=gallery`, { waitUntil: 'networkidle0' })
await page.evaluate(() => document.fonts.ready)
const click = (txt, exact) => page.evaluate((t, ex) => {
  const b = [...document.querySelectorAll('button')].find((x) =>
    ex ? x.textContent.trim().toLowerCase() === t : x.textContent.includes(t))
  b?.click(); return !!b
}, txt, exact)
await click('dashboard', true); await new Promise((r) => setTimeout(r, 900))
await click('__gallery'); await new Promise((r) => setTimeout(r, 700))
await click('Gallery of answer'); await new Promise((r) => setTimeout(r, 2000))

const report = await page.evaluate(() => {
  const sheet = document.querySelector('.ruled')
  const R = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2
  const top0 = sheet.getBoundingClientRect().top
  const off = (v) => Math.min(v % R, R - (v % R))
  return [...sheet.querySelectorAll('.ink-diagram, .hand-table, .step-card header, .step-card > div.lined-text')]
    .map((el) => {
      const r = el.getBoundingClientRect()
      const top = r.top - top0
      return { el: el.className.split(' ')[0] || el.tagName, top: Math.round(top),
               h: Math.round(r.height), ok: off(top) < 0.75 && off(r.height) < 0.75 }
    })
})
const bad = report.filter((r) => !r.ok)
console.log(`${report.length - bad.length}/${report.length} blocks on the rules`, bad.length ? JSON.stringify(bad) : '')

let n = 0
for (const sel of ['.ink-diagram', '.hand-table']) {
  for (const el of await page.$$(sel)) {
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await new Promise((r) => setTimeout(r, 250))
    const b = await el.boundingBox()
    await page.screenshot({ path: `../bench/shot-block-${++n}.png`,
      clip: { x: b.x - 30, y: b.y - 40, width: Math.min(b.width + 60, 1400), height: b.height + 70 } })
  }
}
console.log(`${n} block screenshots; errors: ${errs.length ? errs : 'none'}`)
await browser.close()
await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })
