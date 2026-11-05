// Voice end to end in a real browser: a WAV file stands in for the microphone.
// Click the mic -> live words in the lined box -> pause ends it -> auto-solve.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const wav = process.argv[2]
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1300, height: 900 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
// localhost is a secure context, which getUserMedia needs
await page.goto('http://localhost:8000/?room=voicee2e', { waitUntil: 'networkidle0' })

const box = () => page.$eval('textarea.lined-input', (t) => t.value)
const t0 = Date.now()
await page.click('button[title^="Ask by voice"]')
const seen = []
let last = ''
while (Date.now() - t0 < 30000) {
  const v = await box()
  if (v !== last) { seen.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(v)}`); last = v }
  if (await page.evaluate(() => document.body.textContent.includes('solving in 2 seconds'))) break
  await new Promise((r) => setTimeout(r, 150))
}
console.log('what appeared in the box while speaking:')
seen.slice(0, 12).forEach((s) => console.log('   ', s))
const finalText = await box()
const countdown = await page.evaluate(() => document.body.textContent.includes('solving in 2 seconds'))
console.log('dictated:', JSON.stringify(finalText), '| auto-solve countdown shown:', countdown)

// the countdown should start the solve by itself
const started = await page.waitForFunction(
  () => !!document.querySelector('[data-answer-start]'), { timeout: 15000 }).then(() => true, () => false)
console.log('solve started on its own:', started)
const firstInk = await page.waitForFunction(
  () => document.querySelectorAll('.step-card').length > 0, { timeout: 240000 })
  .then(() => true, () => false)
console.log('answer began writing:', firstInk, `(${((Date.now() - t0) / 1000).toFixed(0)}s after the mic)`)
await page.screenshot({ path: '../bench/shot-voice.png' })

const ok = /derivative/i.test(finalText) && countdown && started && firstInk && !errs.length
console.log('errors:', errs.length ? errs : 'none')
console.log(`\nVOICE E2E: ${ok ? 'PASS' : 'FAIL'}`)
await browser.close()
process.exit(ok ? 0 : 1)
