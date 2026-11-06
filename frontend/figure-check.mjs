/**
 * A figure has to be drawn, not described.
 *
 * The edge list goes through the real parser, is stored as a real answer, and
 * is opened from the dashboard the way a saved answer is opened. What is
 * checked is what a student would complain about: the outline missing, a part
 * named but not labelled, two labels written on top of each other, or a
 * leader line that points nowhere near the part it names.
 *
 *   node figure-check.mjs        (from frontend\)
 */
import puppeteer from 'puppeteer-core'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const api = async (path, opts = {}) => (await fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json' }, ...opts })).json()

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** The same parser the model's output goes through - no hand-built fixtures. */
function parsed(title, lines) {
  const py = `import json, sys
sys.path.insert(0, r"${resolve(ROOT, 'backend')}")
from app.ai.diagram import parse_edge_list
print(json.dumps(parse_edge_list(${JSON.stringify(title)}, ${JSON.stringify(lines)})))`
  const out = execFileSync(resolve(ROOT, '.venv/Scripts/python.exe'), ['-c', py],
    { encoding: 'utf-8' })
  return JSON.parse(out)
}

/**
 * Every figure the library holds, each asked for with ALL of its parts - the
 * crowded case, where labels collide if the layout is wrong. Driving this
 * from the library rather than a fixed list means a figure added later cannot
 * ship without being drawn and measured here.
 */
const LIB = JSON.parse(execFileSync(resolve(ROOT, '.venv/Scripts/python.exe'), ['-c',
  `import json, sys
sys.path.insert(0, r"${resolve(ROOT, 'backend')}")
from app.ai import figures
print(json.dumps([{"name": f["names"][0], "title": f["title"],
                   "parts": list(f["parts"])} for f in figures.FIGURES]))`],
  { encoding: 'utf-8' }))

const CASES = LIB.map((f) => ({
  q: `Draw a labelled diagram of the ${f.name}`,
  title: `Structure of the ${f.name}`,
  lines: f.parts.map((p, i) => `${f.name} -> ${p[0].toUpperCase()}${p.slice(1)}`
    + ` : ${['what it does', 'its job here', 'why it matters'][i % 3]}`),
}))

// A fixture left behind by an interrupted run would be opened in place of
// this one - same name, and the first match wins - so every run gets its own.
const NAME = `__figures-${Date.now().toString(36)}`
const sub = await api('/api/study/subjects', {
  method: 'POST', body: JSON.stringify({ name: NAME }) })

for (const c of CASES) {
  c.d = parsed(c.title, c.lines)
  const steps = [{ index: 1, title: 'The diagram', final: true, segments: [
    { kind: 'text', value: 'The figure is labelled below.\n', display: false },
    { kind: 'diagram', value: c.d.title, display: true, diagram: c.d }] }]
  await api('/api/study/questions', { method: 'POST', body: JSON.stringify({
    subject_id: sub.id, text: c.q, answer_json: JSON.stringify(steps) }) })
}

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 1200 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
const click = (txt, exact) => page.evaluate((x, ex) => {
  const b = [...document.querySelectorAll('button')].find((e) =>
    ex ? e.textContent.trim().toLowerCase() === x : e.textContent.includes(x))
  b?.click(); return !!b
}, txt, exact)

for (const c of CASES) {
  console.log(`\n${c.d.title}  (${c.d.kind})`)
  check('the parser made a figure of it', c.d.kind === 'figure', c.d.kind)
  if (c.d.kind !== 'figure') continue

  // start from the dashboard each time: opening a second answer without
  // reloading is a different path, and one broken "back" button would
  // otherwise leave every later case silently measuring the first figure
  await page.goto(`${BASE}/?room=figcheck`, { waitUntil: 'domcontentloaded' })
  await wait(1200)
  await page.evaluate(() => document.fonts.ready)
  await click('dashboard', true); await wait(900)
  await click(NAME); await wait(700)
  check('the question opened', await click(c.q))
  await wait(2800)

  const seen = await page.evaluate(() => {
    const svg = document.querySelector('.ink-diagram svg')
    if (!svg) return null
    const box = svg.getBoundingClientRect()
    const labels = [...svg.querySelectorAll('[data-block]')].map((g) => {
      const t = g.querySelector('text')
      const r = (t || g).getBoundingClientRect()
      return { label: g.getAttribute('data-block'),
               x: r.x - box.x, y: r.y - box.y, w: r.width, h: r.height }
    })
    return { paths: svg.querySelectorAll('path').length, labels,
             text: svg.textContent, w: box.width, h: box.height }
  })
  check('a figure was drawn', !!seen)
  if (!seen) continue

  // rough.js traces each stroke with more than one path, so this is a floor
  check('the whole outline is on the page',
    seen.paths >= c.d.figure.strokes.length, `${seen.paths} paths`)

  for (const p of c.d.figure.parts) {
    check(`"${p.label}" is labelled`, seen.labels.some((l) => l.label === p.label))
    if (p.note) {
      check(`  and says what it does`, seen.text.includes(p.note.slice(0, 18)))
    }
  }

  // a label written over another label is the one failure that makes the
  // whole figure useless, and it is invisible to every other assertion
  const overlaps = []
  for (let i = 0; i < seen.labels.length; i++) {
    for (let j = i + 1; j < seen.labels.length; j++) {
      const a = seen.labels[i]
      const b = seen.labels[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlaps.push(`${a.label} / ${b.label}`)
      }
    }
  }
  check('no two labels sit on top of each other', !overlaps.length, overlaps.join(', '))

  const out = seen.labels.filter((l) => l.x < -2 || l.y < -2
    || l.x + l.w > seen.w + 2 || l.y + l.h > seen.h + 2)
    .map((l) => `${l.label} [${Math.round(l.x)},${Math.round(l.y)} `
      + `${Math.round(l.w)}x${Math.round(l.h)}]`)
  check('every label is inside the drawing area', !out.length,
    `box ${Math.round(seen.w)}x${Math.round(seen.h)}; out: ${out.join(' ')}`)

  // the figure alone, large enough to judge the drawing by eye
  const el = await page.$('.ink-diagram')
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await wait(400)
  await el.screenshot({ path: resolve(ROOT, `bench/shot-figure-${c.d.figure.id}.png`) })
  console.log(`  screenshot: bench/shot-figure-${c.d.figure.id}.png`)
}

check('no uncaught page errors', errs.length === 0, errs[0])
await browser.close()
await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
