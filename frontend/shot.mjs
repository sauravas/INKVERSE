// Screenshot the built app through the installed Edge/Chrome, so the UI is
// actually looked at rather than assumed.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const exe = CANDIDATES.find(existsSync)
if (!exe) { console.error('no browser'); process.exit(1) }

const base = process.env.BASE || 'http://127.0.0.1:8000'
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=1'],
})

async function shot(path, file, vp, after) {
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport(vp)
  await page.goto(base + path, { waitUntil: 'networkidle0', timeout: 45000 })
  if (after) await after(page)
  await new Promise((r) => setTimeout(r, 700))
  await page.screenshot({ path: file })
  console.log(`${file}  ${errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0,4).join(' | ') : 'clean'}`)
  await page.close()
}

// draw a few strokes on the canvas with synthetic pointer events
const writeOnCanvas = async (page) => {
  const cv = await page.$('canvas.ink-surface')
  if (!cv) { console.log('  (no canvas found)'); return }
  const b = await cv.boundingBox()
  const words = [
    [[0.18,0.17],[0.22,0.14],[0.26,0.19],[0.30,0.14],[0.34,0.18]],
    [[0.38,0.15],[0.42,0.19],[0.46,0.14],[0.50,0.18],[0.54,0.15]],
    [[0.20,0.26],[0.26,0.23],[0.32,0.28],[0.38,0.23],[0.44,0.27],[0.50,0.24]],
  ]
  for (const w of words) {
    await page.mouse.move(b.x + b.width*w[0][0], b.y + b.height*w[0][1])
    await page.mouse.down()
    for (const [x,y] of w.slice(1)) {
      // interpolate so the smoother gets realistic input density
      await page.mouse.move(b.x + b.width*x, b.y + b.height*y, { steps: 14 })
    }
    await page.mouse.up()
  }
}

await shot('/', '../bench/shot-notebook.png', { width: 1440, height: 900 }, writeOnCanvas)
await shot('/', '../bench/shot-dashboard.png', { width: 1440, height: 1100 }, async (p) => {
  await p.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'dashboard')?.click())
  await new Promise((r) => setTimeout(r, 800))
  // expand the first subject so modules + questions are visible
  await p.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.includes('Engineering Mathematics'))?.click())
  await new Promise((r) => setTimeout(r, 900))
})
await shot('/phone?room=shotdemo', '../bench/shot-phone.png',
  { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  writeOnCanvas)

// Open a solved question from the dashboard so the answer sheet renders.
await shot('/', '../bench/shot-answer.png', { width: 1440, height: 1000 }, async (p) => {
  await p.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'dashboard')?.click())
  await new Promise((r) => setTimeout(r, 800))
  await p.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.includes('Engineering Mathematics'))?.click())
  await new Promise((r) => setTimeout(r, 800))
  await p.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.includes('Evaluate the integral'))?.click())
  await new Promise((r) => setTimeout(r, 1500))
  const katex = await p.evaluate(() => document.querySelectorAll('.katex').length)
  console.log('  KaTeX nodes rendered:', katex)
  // the answer is written further down the same sheet
  await p.evaluate(() => document.querySelector('[data-answer-start]')
    ?.scrollIntoView({ block: 'start' }))
  await new Promise((r) => setTimeout(r, 600))
})

await browser.close()
