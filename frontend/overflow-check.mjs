/**
 * Does anything run off the edge of the ruled page?
 *
 * Opens real saved answers and measures every piece of content inside the
 * paper against the paper's own content box. Reports what sticks out, how
 * far, and what kind of thing it is - a long formula, a code block and a
 * table overflow for different reasons and need different fixes.
 *
 *   node overflow-check.mjs            (from frontend\)
 *   node overflow-check.mjs 420        (at a phone width)
 */
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const WIDTH = parseInt(process.argv[2] || '1500', 10)

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: WIDTH, height: 1200 })
const click = (txt, exact) => page.evaluate((x, ex) => {
  const b = [...document.querySelectorAll('button')].find((e) =>
    ex ? e.textContent.trim().toLowerCase() === x : e.textContent.includes(x))
  b?.click(); return !!b
}, txt, exact)

await page.goto(`${BASE}/?room=ovf`, { waitUntil: 'domcontentloaded' })
await wait(1400)
await page.evaluate(() => document.fonts.ready)
await click('dashboard', true)
await wait(900)

/** Every subject, every question, until we find pages with answers on them. */
const subjects = await page.evaluate(() => [...document.querySelectorAll('button')]
  .map((b) => b.textContent.trim())
  .filter((t) => t.startsWith('▸'))
  .map((t) => t.slice(1)))
console.log(`viewport ${WIDTH}px · subjects: ${subjects.join(', ')}`)

/** What sticks out of the paper, and by how much. */
async function measure(label) {
  const out = await page.evaluate(() => {
    const paper = document.querySelector('[data-paper]')
    if (!paper) return null
    const cs = getComputedStyle(paper)
    const box = paper.getBoundingClientRect()
    const left = box.left + parseFloat(cs.paddingLeft)
    const right = box.right - parseFloat(cs.paddingRight)
    const bad = []
    // Content inside a scrolling box is clipped by it, so its children stick
    // out of the paper on paper only - they are not visible there. Measure
    // the box, not what it holds.
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== paper; p = p.parentElement) {
        const o = getComputedStyle(p)
        if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true
      }
      return false
    }
    for (const el of paper.querySelectorAll('*')) {
      if (!el.getClientRects().length) continue
      if (clipped(el)) continue
      // only things that actually paint content
      const tag = el.tagName.toLowerCase()
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      const over = Math.round(r.right - right)
      const under = Math.round(left - r.left)
      if (over > 2 || under > 2) {
        bad.push({
          tag,
          cls: (el.getAttribute('class') || '').split(' ').slice(0, 3).join(' '),
          over, under, w: Math.round(r.width),
          text: (el.textContent || '').trim().slice(0, 48),
        })
      }
    }
    // the outermost offender of each run is the one worth reporting; a child
    // sticking out usually means its parent does too
    const seen = new Set()
    const top = bad.filter((b) => {
      const key = b.text.slice(0, 24) + b.over
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { paperW: Math.round(right - left), count: bad.length, top: top.slice(0, 8) }
  })
  if (!out) return false
  console.log(`\n  ${label}: paper ${out.paperW}px wide, ${out.count} element(s) outside it`)
  for (const b of out.top) {
    console.log(`     ${b.over > 0 ? `+${b.over}px right` : `${b.under}px left`}`
      + `  <${b.tag} class="${b.cls}"> w=${b.w}  ${JSON.stringify(b.text)}`)
  }
  check(`nothing runs off the page in ${label}`, out.count === 0)
  return true
}

let found = 0
for (const s of subjects) {
  if (found >= 3) break
  await click(s.slice(0, 24))
  await wait(900)
  const questions = await page.evaluate(() => [...document.querySelectorAll('button')]
    .map((b) => b.textContent.trim())
    .filter((t) => t.length > 25 && !/^(back|dashboard|import|notes)/i.test(t))
    .slice(0, 6))
  for (const q of questions) {
    if (found >= 3) break
    if (!(await click(q.slice(0, 30)))) continue
    await wait(2200)
    const has = await page.evaluate(() => !!document.querySelector('[data-step-index]'))
    if (has) {
      found++
      await measure(`${s} — ${q.slice(0, 40)}`)
      await page.screenshot({ path: resolve(ROOT, `bench/shot-overflow-${WIDTH}-${found}.png`),
                              fullPage: true })
      console.log(`     screenshot: bench/shot-overflow-${WIDTH}-${found}.png`)
    }
    await page.goto(`${BASE}/?room=ovf`, { waitUntil: 'domcontentloaded' })
    await wait(1200)
    await click('dashboard', true)
    await wait(800)
    await click(s)
    await wait(600)
  }
}
check('found saved answers to measure', found > 0)
await browser.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
