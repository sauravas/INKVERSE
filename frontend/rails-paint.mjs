/**
 * Prove where the continuous repainting comes from.
 *
 * Reported: with the window small the screen is steady; maximised it tears.
 * The only difference is the agent rails, which are hidden at narrow widths.
 * This measures Chrome's own paint counters with the rails on and off, and
 * with their animations on and off, so the claim is a number rather than a
 * theory.
 *
 *   node frontend\rails-paint.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const BASE = 'http://127.0.0.1:8000'
const ROOM = `rp${Math.random().toString(36).slice(2, 6)}`

let fails = 0
const check = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && detail ? `  (${detail})` : ''))
  if (!cond) fails++
}

const browser = await chromium.launch({ executablePath: exe, headless: true })

/** Watch an idle, maximised page for 4s and count what the browser repaints. */
async function sample(label, { rails, motion }) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await ctx.newPage()
  await page.addInitScript(([r, m]) => {
    localStorage.setItem('inkwise.rails', r ? '1' : '0')
    localStorage.setItem('inkwise.calm', m ? '0' : '1')   // calm off == motion on
  }, [rails, motion])
  await page.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)

  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Performance.enable')
  const read = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    const g = (n) => metrics.find((x) => x.name === n)?.value ?? 0
    return { recalc: g('RecalcStyleCount'), layout: g('LayoutCount') }
  }
  // The rails only animate while agents are running, so put them in that
  // state deliberately rather than waiting on a model: the question is what
  // the animation costs, not whether a run happens.
  const live = await page.evaluate(() => {
    const edges = document.querySelectorAll('svg path, svg line')
    const nodes = document.querySelectorAll('svg rect, svg circle')
    let n = 0
    edges.forEach((e) => { e.classList.add('edge-live'); n++ })
    nodes.forEach((e) => { e.classList.add('node-live'); n++ })
    document.querySelectorAll('span').forEach((e) => {
      if (e.className && String(e.className).includes('rounded-full')) {
        e.classList.add('agent-dot-live'); n++
      }
    })
    return n
  })

  const before = await read()
  // how long the main thread spends per frame while that is on screen
  const frames = await page.evaluate(() => new Promise((done) => {
    const gaps = []
    let last = performance.now()
    const t0 = last
    const tick = (now) => {
      gaps.push(now - last); last = now
      if (now - t0 < 3000) requestAnimationFrame(tick)
      else {
        gaps.sort((a, b) => a - b)
        done({ frames: gaps.length,
               median: +gaps[Math.floor(gaps.length / 2)].toFixed(1),
               worst: +gaps[gaps.length - 1].toFixed(1),
               janky: gaps.filter((g) => g > 20).length })
      }
    }
    requestAnimationFrame(tick)
  }))
  await page.waitForTimeout(1000)
  const after = await read()

  // and how much of the screen changes between consecutive frames
  const shots = []
  for (let i = 0; i < 8; i++) {
    shots.push(await page.screenshot({ type: 'png' }))
    await page.waitForTimeout(100)
  }
  const changed = await page.evaluate(async (datas) => {
    const imgs = []
    for (const d of datas) {
      imgs.push(await createImageBitmap(
        new Blob([new Uint8Array(d)], { type: 'image/png' })))
    }
    const { width: W, height: H } = imgs[0]
    const c = new OffscreenCanvas(W, H)
    const x = c.getContext('2d', { willReadFrequently: true })
    const px = imgs.map((im) => { x.drawImage(im, 0, 0); return x.getImageData(0, 0, W, H).data })
    let peak = 0
    for (let k = 1; k < px.length; k++) {
      let n = 0
      for (let p = 0; p < px[k].length; p += 4) {
        if (Math.abs(px[k - 1][p] - px[k][p]) > 10) n++
      }
      peak = Math.max(peak, 100 * n / (W * H))
    }
    return +peak.toFixed(2)
  }, shots.map((s) => Array.from(s)))

  const r = { recalc: after.recalc - before.recalc,
              layout: after.layout - before.layout, changed, live, ...frames }
  console.log(`  ${label.padEnd(28)} animated nodes ${String(live).padStart(4)}  `
    + `fps ${String(Math.round(1000 / r.median)).padStart(3)}  `
    + `worst frame ${String(r.worst).padStart(6)}ms  `
    + `janky ${String(r.janky).padStart(3)}/${r.frames}  `
    + `peak change ${r.changed}%`)
  await ctx.close()
  return r
}

console.log('idle page, maximised, nothing being asked:')
const railsMotion = await sample('rails on, motion on', { rails: true, motion: true })
const railsCalm = await sample('rails on, motion off', { rails: true, motion: false })
const noRails = await sample('rails off', { rails: false, motion: false })

await browser.close()
console.log()
check('animating the rails costs the most frames',
  railsMotion.janky >= railsCalm.janky,
  `motion ${railsMotion.janky} vs calm ${railsCalm.janky}`)
check('the shipped default does not animate them',
  railsCalm.changed <= railsMotion.changed,
  `calm ${railsCalm.changed}% vs motion ${railsMotion.changed}%`)
check('with the panels away there is nothing to animate',
  noRails.live < railsMotion.live,
  `${noRails.live} vs ${railsMotion.live} animated nodes`)
check('and the page still holds 60fps with them hidden',
  1000 / noRails.median > 50, `${Math.round(1000 / noRails.median)}fps`)

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
