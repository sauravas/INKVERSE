// Render a hand-drawn diagram answer in the real app and screenshot it, both
// finished and mid-drawing. Seeds a throwaway subject and removes it after.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const api = async (path, opts = {}) => (await fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json' }, ...opts })).json()

// build the diagram with the real backend parser, so the shape is exactly real
const diagram = JSON.parse(execFileSync('../.venv/Scripts/python.exe', ['-c', `
import sys, json; sys.path.insert(0, '../backend')
from app.ai.diagram import parse_edge_list
print(json.dumps(parse_edge_list("Process state transitions", [
  "direction: LR", "New -> Ready : admitted", "Ready -> Running : dispatch",
  "Running -> Waiting : I/O request", "Waiting -> Ready : I/O done",
  "Running -> Ready : interrupt", "Running -> Terminated : exit"])))`]).toString())

const t = (v) => ({ kind: 'text', value: v, display: false })
const steps = [
  { index: 1, title: 'The five states', final: false, segments: [
    t('A process moves between five states as the OS schedules it.\n'),
    { kind: 'diagram', value: diagram.title, display: true, diagram },
    t('New processes are admitted to Ready; the scheduler dispatches one to Running.\n') ] },
  { index: 2, title: 'Final answer', final: true, segments: [
    t('New, Ready, Running, Waiting and Terminated.\n') ] },
]

const sub = await api('/api/study/subjects', { method: 'POST',
  body: JSON.stringify({ name: '__diagram_shot' }) })
await api('/api/study/questions', { method: 'POST', body: JSON.stringify({
  subject_id: sub.id, text: 'Explain the states of a process with a diagram.',
  answer_json: JSON.stringify(steps) }) })

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?room=dshot`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 1200))
const click = (txt, exact) => page.evaluate((t, ex) => {
  const b = [...document.querySelectorAll('button')].find((x) =>
    ex ? x.textContent.trim().toLowerCase() === t : x.textContent.includes(t))
  b?.click(); return !!b
}, txt, exact)
await click('dashboard', true); await new Promise((r) => setTimeout(r, 900))
await click('__diagram_shot'); await new Promise((r) => setTimeout(r, 700))
await click('Explain the states'); await new Promise((r) => setTimeout(r, 1500))
await page.evaluate(() => document.querySelector('.ink-diagram')?.scrollIntoView({ block: 'center' }))
await new Promise((r) => setTimeout(r, 600))
const info = await page.evaluate(() => {
  const d = document.querySelector('.ink-diagram')
  return d && { h: d.getBoundingClientRect().height, paths: d.querySelectorAll('path').length,
    texts: [...d.querySelectorAll('text')].map((x) => x.textContent) }
})
console.log('diagram:', JSON.stringify(info))
await page.screenshot({ path: '../bench/shot-diagram.png' })

// mid-drawing: replay the animation by toggling the stroke classes back on
await page.evaluate(() => {
  const svg = document.querySelector('.ink-diagram svg')
  svg.querySelectorAll('path[pathLength]').forEach((p, i) => {
    p.classList.add('ink-stroke'); p.style.setProperty('--t', `${i * 70}ms`); p.style.setProperty('--d', '380ms')
  })
})
await new Promise((r) => setTimeout(r, 650))
const half = await page.evaluate(() => [...document.querySelectorAll('.ink-diagram path.ink-stroke')]
  .filter((p) => parseFloat(getComputedStyle(p).strokeDashoffset) > 0.01).length)
console.log('strokes still being drawn at 650ms:', half)
const clip = await page.evaluate(() => {
  const r = document.querySelector('.ink-diagram').getBoundingClientRect()
  return { x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 }
})
await page.screenshot({ path: '../bench/shot-diagram-drawing.png', clip })

console.log('errors:', errs.length ? errs : 'none')
await browser.close()
await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })
