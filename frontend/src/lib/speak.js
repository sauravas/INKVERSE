// Reading answers aloud with an on-device voice.

const GREEK = 'alpha beta gamma delta epsilon theta lambda mu pi rho sigma tau phi omega'.split(' ')

/** LaTeX -> words a voice can say: \frac{a}{b} -> "a over b", x^2 -> "x squared". */
export function speakableMath(tex) {
  let s = ` ${tex} `
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, ' $1 over $2 ')
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, ' square root of $1 ')
  }
  s = s
    // only an exponent of exactly 2 or 3: e^{3x} is "to the power 3x", not "cubed x"
    .replace(/\^(\{2\}|2(?![\w.]))/g, ' squared ').replace(/\^(\{3\}|3(?![\w.]))/g, ' cubed ')
    .replace(/\^\{([^{}]*)\}/g, ' to the power $1 ').replace(/\^(\w)/g, ' to the power $1 ')
    .replace(/_\{([^{}]*)\}/g, ' sub $1 ').replace(/_(\w)/g, ' sub $1 ')
    .replace(/\\int/g, ' integral of ').replace(/\\sum/g, ' sum of ')
    .replace(/\\(lim)/g, ' limit ').replace(/\\infty/g, ' infinity ')
    .replace(/\\(cdot|times)/g, ' times ').replace(/\\div/g, ' divided by ')
    .replace(/\\(leq|le)\b/g, ' less than or equal to ').replace(/\\(geq|ge)\b/g, ' greater than or equal to ')
    .replace(/\\pm/g, ' plus or minus ').replace(/\\neq/g, ' not equal to ').replace(/\\approx/g, ' approximately ')
    .replace(/\\(sin|cos|tan|log|ln|exp)\b/g, ' $1 ')
    .replace(/\\left|\\right|\\,|\\;|\\!|\\quad|\\text|\\mathrm|\\displaystyle|\\boxed/g, ' ')
  for (const g of GREEK) s = s.replace(new RegExp(`\\\\${g}\\b`, 'g'), ` ${g} `)
  s = s.replace(/=/g, ' equals ').replace(/\+/g, ' plus ').replace(/(?<=\s|\w)-(?=\s|\w)/g, ' minus ')
    .replace(/</g, ' less than ').replace(/>/g, ' greater than ')
    .replace(/\bd([xyt])\b/g, ' d $1 ')
    .replace(/[{}\\$]/g, ' ').replace(/\s+/g, ' ')
  return s.trim()
}

/** One step as speech: its title, then its words and maths in order. */
export function speakableStep(step) {
  const parts = [step.final ? 'Final answer.' : `Step ${step.index}. ${step.title || ''}.`]
  for (const seg of step.segments) {
    if (seg.kind === 'text') parts.push(seg.value)
    else if (seg.kind === 'math') parts.push(speakableMath(seg.value))
    else if (seg.kind === 'diagram') parts.push(`See the diagram: ${seg.diagram?.title || ''}.`)
    else if (seg.kind === 'table') parts.push('See the table.')
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

let voice = null
function pickVoice() {
  if (voice) return voice
  const all = window.speechSynthesis?.getVoices() || []
  // local voices only: "Online (Natural)" voices send the text to a server
  const local = all.filter((v) => v.localService && v.lang?.startsWith('en'))
  voice = local.find((v) => /zira|aria|jenny|female/i.test(v.name)) || local[0] || null
  return voice
}

export function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Speak a list of strings in order. Returns a function that stops speaking. */
export function speak(texts) {
  if (!canSpeak()) return () => {}
  const synth = window.speechSynthesis
  synth.cancel()
  const v = pickVoice()
  for (const t of texts.filter(Boolean)) {
    const u = new SpeechSynthesisUtterance(t)
    if (v) u.voice = v
    u.rate = 1.0
    synth.speak(u)
  }
  return () => synth.cancel()
}

if (canSpeak()) window.speechSynthesis.onvoiceschanged = () => { voice = null }
