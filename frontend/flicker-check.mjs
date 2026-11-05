import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = process.argv[3] || 'http://127.0.0.1:8000'
const VIEW = process.argv[2] || 'notebook'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         protocolTimeout: 120000, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
await page.goto(`${BASE}/?room=flicker`, { waitUntil: 'domcontentloaded' })
await wait(2500)
if (VIEW !== 'notebook') {
  await page.evaluate((v) => {
    const b = [...document.querySelectorAll('button')]
      .find((e) => e.textContent.trim().toLowerCase() === v)
    b?.click()
  }, VIEW)
  await wait(2000)
}

const report = await page.evaluate(async () => {
  const counts = { mutations: 0, byTarget: {}, attrs: {} }
  const obs = new MutationObserver((records) => {
    counts.mutations += records.length
    for (const r of records) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement
      if (!el) continue
      const key = `${el.tagName}.${String(el.className?.baseVal ?? el.className ?? '')
        .split(' ').slice(0, 2).join('.')}`.slice(0, 60)
      counts.byTarget[key] = (counts.byTarget[key] || 0) + 1
      if (r.type === 'attributes') {
        counts.attrs[r.attributeName] = (counts.attrs[r.attributeName] || 0) + 1
      }
    }
  })
  obs.observe(document.body, { subtree: true, childList: true,
                               attributes: true, characterData: true })
  let frames = 0
  const t0 = performance.now()
  await new Promise((done) => {
    const tick = () => {
      frames++
      if (performance.now() - t0 < 5000) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  obs.disconnect()
  const secs = (performance.now() - t0) / 1000
  return {
    seconds: +secs.toFixed(1),
    mutationsPerSecond: Math.round(counts.mutations / secs),
    fps: Math.round(frames / secs),
    top: Object.entries(counts.byTarget).sort((a, b) => b[1] - a[1]).slice(0, 8),
    attrs: Object.entries(counts.attrs).sort((a, b) => b[1] - a[1]).slice(0, 6),
  }
})

console.log(`view=${VIEW}  ${report.seconds}s  fps=${report.fps}  `
  + `DOM mutations/sec=${report.mutationsPerSecond}`)
console.log('busiest nodes:')
for (const [k, n] of report.top) console.log(`   ${String(n).padStart(5)}  ${k}`)
if (report.attrs.length) {
  console.log('attributes churned:', report.attrs.map(([a, n]) => `${a}=${n}`).join(' '))
}
await browser.close()
process.exit(report.mutationsPerSecond > 40 ? 1 : 0)
