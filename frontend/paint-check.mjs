// Find what actually flickers: pixel-diff consecutive frames during a run and
// report Chrome's own layout/style-recalc counters. DOM mutation counts miss a
// full-page repaint; this does not.
import puppeteer from 'puppeteer-core'
import { existsSync, writeFileSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         protocolTimeout: 300000, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const cdp = await page.createCDPSession()
await cdp.send('Performance.enable')

await page.goto(`${BASE}/?room=paint`, { waitUntil: 'domcontentloaded' })
await wait(2500)

const metrics = async () => {
  const { metrics: m } = await cdp.send('Performance.getMetrics')
  const g = (n) => m.find((x) => x.name === n)?.value ?? 0
  return { layout: g('LayoutCount'), recalc: g('RecalcStyleCount'),
           layoutMs: +g('LayoutDuration').toFixed(2),
           recalcMs: +g('RecalcStyleDuration').toFixed(2),
           scriptMs: +g('ScriptDuration').toFixed(2) }
}

// ask a question the way a student does
await page.evaluate(() => {
  const el = document.querySelector('textarea, input[type="text"]')
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set
    .call(el, 'Differentiate 4x^2 + 3x with respect to x')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})

// sample: N screenshots back to back, report how much of the frame changed
const burst = async (label, n = 14) => {
  const before = await metrics()
  const shots = []
  for (let i = 0; i < n; i++) {
    shots.push(await page.screenshot({ encoding: 'binary' }))
    await wait(110)
  }
  const after = await metrics()

  // decode each PNG in the page itself and diff row bands, so we can say
  // *where* on the screen the change is, not just how much
  const diffs = await page.evaluate(async (datas) => {
    const imgs = []
    for (const d of datas) {
      const blob = new Blob([new Uint8Array(d)], { type: 'image/png' })
      imgs.push(await createImageBitmap(blob))
    }
    const { width: W, height: H } = imgs[0]
    const c = new OffscreenCanvas(W, H)
    const x = c.getContext('2d', { willReadFrequently: true })
    const pix = imgs.map((im) => { x.drawImage(im, 0, 0); return x.getImageData(0, 0, W, H).data })
    const BANDS = 6
    const out = []
    for (let k = 1; k < pix.length; k++) {
      const a = pix[k - 1]; const b = pix[k]
      const bands = new Array(BANDS).fill(0)
      let changed = 0
      for (let p = 0; p < a.length; p += 4) {
        if (Math.abs(a[p] - b[p]) > 8 || Math.abs(a[p + 1] - b[p + 1]) > 8
            || Math.abs(a[p + 2] - b[p + 2]) > 8) {
          changed++
          const y = Math.floor((p / 4) / W)
          bands[Math.min(BANDS - 1, Math.floor(y / (H / BANDS)))]++
        }
      }
      out.push({ pct: +(100 * changed / (W * H)).toFixed(1),
                 bands: bands.map((v) => +(100 * v / (W * H / BANDS)).toFixed(0)) })
    }
    return out
  }, shots.map((s) => Array.from(s)))

  const pcts = diffs.map((d) => d.pct)
  console.log(`\n[${label}]`)
  console.log(`  frame-to-frame change: max ${Math.max(...pcts)}%  `
    + `median ${pcts.slice().sort((a, b) => a - b)[Math.floor(pcts.length / 2)]}%`)
  console.log(`  per-frame: ${pcts.join(' ')}`)
  const worst = diffs[pcts.indexOf(Math.max(...pcts))]
  console.log(`  worst frame by screen band (top->bottom): ${worst.bands.join(' ')} %`)
  console.log(`  layouts ${after.layout - before.layout}  `
    + `style recalcs ${after.recalc - before.recalc}  `
    + `layout ${(after.layoutMs - before.layoutMs).toFixed(2)}s  `
    + `recalc ${(after.recalcMs - before.recalcMs).toFixed(2)}s  `
    + `script ${(after.scriptMs - before.scriptMs).toFixed(2)}s`)
  return Math.max(...pcts)
}

await wait(800)
await burst('model working (nothing should move)')
await wait(22000)
const writing = await burst('answer being written')
await wait(40000)
const idle = await burst('after the run')

await browser.close()
console.log(`\nverdict: ${idle > 5 ? 'STILL REPAINTING WHEN IDLE' : 'idle is quiet'}; `
  + `peak repaint while writing ${writing}% of the screen`)
