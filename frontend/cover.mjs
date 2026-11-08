/**
 * The cover image: one picture that says what INKWISE is instead of a chatbot.
 *
 * Built from the app's own palette and its own handwriting font, served from
 * the running app so the type is the real thing rather than a lookalike.
 *
 *   node cover.mjs            (from frontend\, with the app running)
 *
 * Writes docs/cover.png (wide, for a link preview) and docs/cover-portrait.png
 * (tall, which is what fills the feed on a phone).
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

const INK = '#16213a'
const SOFT = '#46557a'
const ACCENT = '#2f6fed'
const PAPER = '#fbf9f3'
const DESK = '#eceadf'

/** @param {{w:number,h:number,tall:boolean}} s */
const html = (s) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Caveat';
    src: url('${BASE}/fonts/Caveat.ttf') format('truetype-variations');
    font-weight: 400 700;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${s.w}px; height: ${s.h}px; background: ${DESK};
    font-family: ui-sans-serif, system-ui, 'Segoe UI', sans-serif; color: ${INK};
    display: flex; flex-direction: column;
    padding: ${s.tall ? '70px 66px 58px' : '56px 64px 48px'};
    position: relative; overflow: hidden;
  }
  /* the faint ruled grid of the desk, same rhythm as the notebook */
  body::before {
    content: ''; position: absolute; inset: 0;
    background-image: repeating-linear-gradient(to bottom,
      transparent 0 73px, rgba(70,85,122,.07) 73px 74px);
    pointer-events: none;
  }
  .top { display: flex; align-items: baseline; gap: 18px; position: relative; }
  .mark { font-size: ${s.tall ? 52 : 44}px; font-style: italic; font-weight: 600;
          letter-spacing: .14em; }
  .tag { font-size: ${s.tall ? 21 : 19}px; color: ${SOFT}; letter-spacing: .02em; }

  .head {
    font-family: 'Caveat', cursive; font-variation-settings: 'wght' 600;
    font-size: ${s.tall ? 92 : 74}px; line-height: 1.08; letter-spacing: .005em;
    margin-top: ${s.tall ? 40 : 26}px; position: relative;
    width: ${s.tall ? '92%' : '600px'};
  }
  .head s { text-decoration: none; position: relative; color: ${SOFT};
           opacity: .6; display: inline-block; }
  /* struck through by hand, the way you cross a word out on paper */
  .head s::after {
    content: ''; position: absolute; left: -6px; right: -8px; top: 52%; height: 5px;
    background: #c0392b; border-radius: 6px; transform: rotate(-1.4deg);
    box-shadow: 0 1px 0 rgba(0,0,0,.08);
  }
  .head em { font-style: normal; color: ${ACCENT}; }

  .sub {
    margin-top: ${s.tall ? 30 : 22}px; font-size: ${s.tall ? 27 : 21}px;
    line-height: 1.5; color: ${SOFT}; width: ${s.tall ? '88%' : '560px'};
    position: relative;
  }
  .sub b { color: ${INK}; font-weight: 600; }

  .chips { display: flex; gap: ${s.tall ? 14 : 12}px; margin-top: auto;
           flex-wrap: wrap; position: relative; }
  .chip {
    background: ${PAPER}; border: 1px solid rgba(22,33,58,.14); border-radius: 999px;
    padding: ${s.tall ? '13px 22px' : '10px 17px'}; font-size: ${s.tall ? 21 : 16}px;
    display: flex; align-items: center; gap: 11px; color: ${INK};
  }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #1f9d55; }

  /* the page itself, sitting on the desk */
  .paper {
    position: absolute; background: ${PAPER}; border-radius: 10px;
    box-shadow: 0 26px 60px rgba(22,33,58,.19), 0 2px 0 rgba(255,255,255,.7) inset;
    border: 1px solid rgba(22,33,58,.09);
    background-image:
      repeating-linear-gradient(to bottom, transparent 0 ${s.tall ? 57 : 45}px, #cfd9ea ${s.tall ? 57 : 45}px ${s.tall ? 58 : 46}px),
      linear-gradient(to right, transparent 0 60px, #e9b7b7 60px 61px, transparent 61px);
    ${s.tall
      ? 'right: 46px; bottom: 300px; width: 840px; height: 470px; transform: rotate(-1.6deg);'
      : 'right: -40px; bottom: 142px; width: 520px; height: 372px; transform: rotate(-2.2deg);'}
    padding: ${s.tall ? '34px 40px 0 92px' : '26px 28px 0 74px'};
    overflow: hidden;
  }
  .q { font-family: 'Caveat', cursive; font-variation-settings: 'wght' 560;
       font-size: ${s.tall ? 46 : 34}px; line-height: ${s.tall ? 58 : 46}px; color: ${INK}; }
  .ans { font-family: 'Caveat', cursive; font-variation-settings: 'wght' 620;
         font-size: ${s.tall ? 41 : 31}px; line-height: ${s.tall ? 58 : 46}px; color: #1f7a4d;
         margin-top: ${s.tall ? 58 : 46}px; }
  .step { font-family: 'Caveat', cursive; font-size: ${s.tall ? 37 : 28}px;
          line-height: ${s.tall ? 58 : 46}px; color: ${ACCENT}; font-variation-settings: 'wght' 600; }
  .work { font-family: 'Caveat', cursive; font-size: ${s.tall ? 37 : 28}px;
          line-height: ${s.tall ? 58 : 46}px; color: ${INK}; }
  .cursor { display: inline-block; width: 3px; height: ${s.tall ? 36 : 30}px;
            background: ${ACCENT}; vertical-align: -5px; margin-left: 4px; }
</style></head><body>
  <div class="top">
    <div class="mark">INKWISE</div>
    <div class="tag">handwriting-first study workspace</div>
  </div>

  <div class="head">
    <s>Copy.</s> <s>Paste.</s> <s>Scroll.</s><br>
    Just <em>write it down.</em>
  </div>

  <div class="sub">
    It reads your page, <b>shows you what it read</b>, and writes the answer
    back by hand — working, diagrams and all.<br>
    Runs entirely on your laptop. Nothing is uploaded.
  </div>

  <div class="chips">
    <div class="chip"><span class="dot"></span>Local models, no API key</div>
    <div class="chip"><span class="dot"></span>Diagrams it cannot hallucinate</div>
    <div class="chip"><span class="dot"></span>Exam-ready is calculated, not guessed</div>
  </div>

  <div class="paper">
    <div class="q">Find&nbsp; ∫ x² sin x dx</div>
    <div class="ans">Answer</div>
    <div class="step">Step 1&nbsp; Integration by parts</div>
    <div class="work">u = x²,&nbsp; dv = sin x dx<span class="cursor"></span></div>
  </div>
</body></html>`

const sizes = [
  { name: 'cover', w: 1200, h: 630, tall: false },
  { name: 'cover-portrait', w: 1080, h: 1350, tall: true },
]

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
                                         args: ['--no-sandbox'] })
for (const s of sizes) {
  const page = await browser.newPage()
  await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 2 })
  await page.setContent(html(s), { waitUntil: 'networkidle0' })
  await page.evaluate(() => document.fonts.ready)
  await new Promise((r) => setTimeout(r, 300))
  const file = resolve(ROOT, `docs/${s.name}.png`)
  await page.screenshot({ path: file })
  console.log(`  ✓ docs/${s.name}.png  ${s.w}x${s.h} @2x`)
  await page.close()
}
await browser.close()
