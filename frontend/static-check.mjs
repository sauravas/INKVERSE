/**
 * "Like static disturbance" - find it with the GPU actually in play.
 *
 * Headless Chrome rasterises on the CPU, so anything caused by GPU
 * compositing is invisible there. This runs headful with the real driver,
 * grabs frames fast, and reports where on the screen pixels are changing
 * when nothing should be moving. It also counts composited layers, because a
 * page that hands the compositor thousands of transformed text nodes is the
 * usual reason a GPU-bound page shimmers.
 *
 *   node frontend\static-check.mjs [--calm] [--solve]
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const CALM = process.argv.includes('--calm')
const SOLVE = process.argv.includes('--solve')

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,                       // real window, real GPU
  args: ['--enable-gpu-rasterization', '--enable-zero-copy'],
})
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
if (CALM) await ctx.addInitScript(() => localStorage.setItem('inkwise.calm', '1'))
await page.goto(`${BASE}/?room=static`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const cdp = await ctx.newCDPSession(page)
const gpu = await cdp.send('SystemInfo.getInfo').catch(() => null)
if (gpu) {
  const g = gpu.gpu?.devices?.[0]
  console.log(`GPU: ${g?.vendorString || '?'} ${g?.deviceString || ''}`.trim())
  const off = Object.entries(gpu.featureStatus || {})
    .filter(([, v]) => /disabled|software/i.test(String(v)))
    .map(([k]) => k)
  console.log(`software-rendered features: ${off.length ? off.join(', ') : 'none'}`)
}

// how much work the compositor is being handed
const layers = await page.evaluate(() => {
  const all = document.querySelectorAll('*')
  let transformed = 0; let willChange = 0; let opacityEls = 0
  for (const el of all) {
    const s = getComputedStyle(el)
    if (s.transform && s.transform !== 'none') transformed++
    if (s.willChange && s.willChange !== 'auto') willChange++
    if (s.opacity !== '1') opacityEls++
  }
  return { nodes: all.length, transformed, willChange, opacityEls }
})
console.log(`DOM ${layers.nodes} nodes · ${layers.transformed} with a transform · `
  + `${layers.opacityEls} with opacity<1 · ${layers.willChange} with will-change`)

if (SOLVE) {
  await page.evaluate(() => {
    const el = document.querySelector('textarea, input[type="text"]')
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set
      .call(el, 'Differentiate 4x^2 + 3x with respect to x')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  console.log('solving… sampling while the model works and while the pen writes')
  await page.waitForTimeout(6000)
}

const burst = async (label, n = 12) => {
  const shots = []
  for (let i = 0; i < n; i++) {
    shots.push(await page.screenshot({ type: 'png' }))
    await page.waitForTimeout(90)
  }
  const r = await page.evaluate(async (datas) => {
    const imgs = []
    for (const d of datas) {
      imgs.push(await createImageBitmap(
        new Blob([new Uint8Array(d)], { type: 'image/png' })))
    }
    const { width: W, height: H } = imgs[0]
    const c = new OffscreenCanvas(W, H)
    const x = c.getContext('2d', { willReadFrequently: true })
    const px = imgs.map((im) => { x.drawImage(im, 0, 0); return x.getImageData(0, 0, W, H).data })
    let maxPct = 0; let worstBands = []
    // "static" = many tiny scattered differences rather than one moving block
    let scattered = 0
    for (let k = 1; k < px.length; k++) {
      const a = px[k - 1]; const b = px[k]
      const bands = new Array(6).fill(0)
      let changed = 0; let runs = 0; let prev = false
      for (let p = 0; p < a.length; p += 4) {
        const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1])
          + Math.abs(a[p + 2] - b[p + 2])
        const hit = d > 12
        if (hit) {
          changed++
          bands[Math.min(5, Math.floor(Math.floor((p / 4) / W) / (H / 6)))]++
          if (!prev) runs++
        }
        prev = hit
      }
      const pct = 100 * changed / (W * H)
      if (pct > maxPct) { maxPct = pct; worstBands = bands.map((v) => +(100 * v / (W * H / 6)).toFixed(0)) }
      // a high run count for the number of changed pixels means speckle
      if (changed > 200 && runs / changed > 0.25) scattered++
    }
    return { maxPct: +maxPct.toFixed(2), worstBands, scattered, frames: px.length - 1 }
  }, shots.map((s) => Array.from(s)))
  console.log(`\n[${label}] peak frame change ${r.maxPct}% of screen; `
    + `speckled frames ${r.scattered}/${r.frames}`)
  console.log(`   by band top->bottom: ${r.worstBands.join(' ')} %`)
  return r
}

await burst(SOLVE ? 'while the answer is written' : 'idle page')
if (SOLVE) { await page.waitForTimeout(45000); await burst('after the run') }

await page.screenshot({ path: '../bench/static-check.png' })
await browser.close()
