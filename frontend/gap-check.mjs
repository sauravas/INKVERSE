// Draw a realistic 3-line question, then open a saved answer, and measure the
// gap between the end of the writing area and the start of the Answer section.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1200 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?room=gapcheck${Date.now().toString(36).slice(-4)}`,
  { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 700))

const cv = await page.$('canvas.ink-surface')
let b = await cv.boundingBox()
console.log('canvas height before writing:', Math.round(b.height), 'px')

// three lines of a realistic multi-line question
const lines = [0.15, 0.35, 0.55]
for (const y of lines) {
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(b.x + b.width * (0.1 + i * 0.08),
      b.y + b.height * (y + (i % 2 ? 0.02 : -0.015)), { steps: 8 })
  }
  await page.mouse.up()
  b = await (await page.$('canvas.ink-surface')).boundingBox() // refit may have resized it
}
await new Promise((r) => setTimeout(r, 500))

b = await (await page.$('canvas.ink-surface')).boundingBox()
console.log('canvas height after 3-line question:', Math.round(b.height), 'px')

// go to the dashboard, open the pre-seeded solved question
await page.evaluate(() => [...document.querySelectorAll('button')]
  .find((btn) => btn.textContent.trim().toLowerCase() === 'dashboard')?.click())
await new Promise((r) => setTimeout(r, 800))
await page.evaluate(() => [...document.querySelectorAll('button')]
  .find((btn) => btn.textContent.includes('Engineering Mathematics'))?.click())
await new Promise((r) => setTimeout(r, 800))
await page.evaluate(() => [...document.querySelectorAll('button')]
  .find((btn) => btn.textContent.includes('Evaluate the integral'))?.click())
await new Promise((r) => setTimeout(r, 1200))

const measured = await page.evaluate(() => {
  const cv = document.querySelector('canvas.ink-surface')
  const ans = document.querySelector('[data-answer-start]')
  if (!cv || !ans) return null
  const cvBox = cv.getBoundingClientRect()
  const ansBox = ans.getBoundingClientRect()
  return { canvasBottom: cvBox.bottom, answerTop: ansBox.top, canvasHeight: cvBox.height }
})
console.log('canvas height on reopen:', Math.round(measured?.canvasHeight), 'px')
// one ruled line of gap is the typed-question row that sits between them
const gap = Math.round(measured?.answerTop - measured?.canvasBottom)
const rule = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize) * 2)
console.log(`gap between writing area bottom and Answer heading: ${gap}px`,
  gap <= rule ? '(the typed-question line; OK)' : '(TOO MUCH)')

await page.screenshot({ path: '../bench/shot-gapcheck.png', fullPage: true })
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none')
await browser.close()
