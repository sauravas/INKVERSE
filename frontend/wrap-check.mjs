// Does handwritten text ever break in the middle of a word?
import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:8000'
const api = async (p, o = {}) => (await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...o })).json()
const t = (v) => ({ kind: 'text', value: v, display: false })
const long = 'A process state diagram illustrates the different states a process can be in and the transitions between them. The key states are New, Ready, Running, Waiting and Terminated, with extraordinarily lengthy explanatory words such as incomprehensibility.\n'
const steps = [{ index: 1, title: 'Wrapping', final: false, segments: [t(long)] }]
const sub = await api('/api/study/subjects', { method: 'POST', body: JSON.stringify({ name: '__wrap' }) })
await api('/api/study/questions', { method: 'POST', body: JSON.stringify({ subject_id: sub.id, text: 'Wrap test', answer_json: JSON.stringify(steps) }) })
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 900 })   // narrow, to force wrapping
await page.goto(`${BASE}/?room=wrapchk`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => document.fonts.ready)
const click = (x, ex) => page.evaluate((x, ex) => { const b = [...document.querySelectorAll('button')].find((b) => ex ? b.textContent.trim().toLowerCase() === x : b.textContent.includes(x)); b?.click(); return !!b }, x, ex)
await click('dashboard', true); await new Promise((r) => setTimeout(r, 900))
await click('__wrap'); await new Promise((r) => setTimeout(r, 700))
await click('Wrap test'); await new Promise((r) => setTimeout(r, 1800))
const broken = await page.evaluate(() => {
  const body = document.querySelector('[data-step-index="1"] > div.lined-text')
  const bad = []
  for (const w of body.querySelectorAll('span[style*="nowrap"]')) {
    const rects = [...w.getClientRects()]
    if (rects.length > 1 && rects.some((r, i) => i && Math.abs(r.top - rects[0].top) > 2)) {
      bad.push(w.textContent)
    }
  }
  return { words: body.querySelectorAll('span[style*="nowrap"]').length, bad }
})
console.log(`words: ${broken.words}, split across lines: ${broken.bad.length}`, broken.bad.slice(0, 5))
console.log(broken.bad.length === 0 ? 'WRAP: PASS' : 'WRAP: FAIL')
await browser.close(); await fetch(`${BASE}/api/study/subjects/${sub.id}`, { method: 'DELETE' })
process.exit(broken.bad.length ? 1 : 0)
