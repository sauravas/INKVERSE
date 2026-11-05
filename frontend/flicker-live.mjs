// Measure DOM churn while a run is actually happening: the agent rails are
// animating, the pen is writing, and the SSE feed is delivering events.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         protocolTimeout: 300000, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
await page.goto(`${BASE}/?room=flickerlive`, { waitUntil: 'domcontentloaded' })
await wait(2500)

// type a question and send it, the way a student would
const typed = await page.evaluate(() => {
  const el = document.querySelector('textarea, input[type="text"]')
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set
    .call(el, 'Differentiate 4x^2 + 3x with respect to x')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})
console.log('question typed:', typed)
await wait(1500)

const sample = async (label) => {
  const r = await page.evaluate(async () => {
    const counts = { mutations: 0, byTarget: {} }
    const obs = new MutationObserver((recs) => {
      counts.mutations += recs.length
      for (const rec of recs) {
        const el = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement
        if (!el) continue
        const cls = String(el.className?.baseVal ?? el.className ?? '')
        const key = `${el.tagName}.${cls.split(' ').slice(0, 2).join('.')}`.slice(0, 58)
        counts.byTarget[key] = (counts.byTarget[key] || 0) + 1
      }
    })
    obs.observe(document.body, { subtree: true, childList: true,
                                 attributes: true, characterData: true })
    let frames = 0
    const t0 = performance.now()
    await new Promise((done) => {
      const tick = () => {
        frames++
        if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    obs.disconnect()
    const secs = (performance.now() - t0) / 1000
    return { mps: Math.round(counts.mutations / secs), fps: Math.round(frames / secs),
             top: Object.entries(counts.byTarget).sort((a, b) => b[1] - a[1]).slice(0, 6) }
  })
  console.log(`\n[${label}] fps=${r.fps}  mutations/sec=${r.mps}`)
  for (const [k, n] of r.top) console.log(`   ${String(n).padStart(6)}  ${k}`)
  return r
}

await sample('while the model is working')
await wait(25000)
await sample('while the answer is being written')
await wait(45000)
const idle = await sample('after the run has finished')

await page.screenshot({ path: '../bench/flicker-live.png' })
await browser.close()
console.log(idle.mps > 40
  ? '\nSTILL CHURNING AFTER THE RUN - something is animating that should have stopped'
  : '\nsettles when idle')
