// How maths is read aloud. Run: node speak-test.mjs
import { speakableMath } from './src/lib/speak.js'

const cases = [
  ['\\frac{d}{dx} x^2 \\sin x = 2x \\sin x + x^2 \\cos x', 'd over d x x squared sin x equals 2x sin x plus x squared cos x'],
  ['I = \\int x^2 e^{3x}\\,dx', 'I equals integral of x squared e to the power 3x d x'],
  ['v = \\tfrac{1}{3}e^{3x}', 'v equals 1 over 3 e to the power 3x'],
  ['x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', null],
  ['a_n \\leq \\pi r^2', 'a sub n less than or equal to pi r squared'],
  ['y = x^{23}', 'y equals x to the power 23'],
]
let ok = true
for (const [tex, want] of cases) {
  const got = speakableMath(tex)
  const pass = want === null || got === want
  ok &&= pass
  console.log(`${pass ? 'OK  ' : 'DIFF'} ${tex.padEnd(46)} -> ${got}${pass ? '' : `\n     wanted: ${want}`}`)
}
console.log(ok ? 'SPEAK: PASS' : 'SPEAK: FAIL')
