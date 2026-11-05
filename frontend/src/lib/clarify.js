// Turn two disagreeing readings of a handwritten question into specific
// questions for the student: "did you write 4x^2 or 2x^2?", not "here are two
// sentences, spot the difference".

// maths stays one token, so "$4x^2$" vs "$2x^2$" is one difference, not five
const TOKEN = /\$\$[\s\S]+?\$\$|\$[^$]+\$|\\\([\s\S]+?\\\)|\S+/g

function tokens(s) {
  return (s || '').match(TOKEN) || []
}

const norm = (t) => t.toLowerCase().replace(/[.,;:!?]+$/, '')

/** Longest common subsequence over tokens, as a list of aligned pairs. */
function align(a, b) {
  const n = a.length
  const m = b.length
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = norm(a[i]) === norm(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (norm(a[i]) === norm(b[j])) { pairs.push([i, j]); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * Where two readings differ: [{ mine, theirs, before }] - at most `max` of
 * them. `mine` is the text in the first reading, `theirs` in the second, and
 * `before` a few words of context so the student can find the spot.
 */
export function differences(first, second, max = 3) {
  const a = tokens(first)
  const b = tokens(second)
  const pairs = [...align(a, b), [a.length, b.length]]
  const out = []
  let pi = 0
  let pj = 0
  for (const [i, j] of pairs) {
    if (i > pi || j > pj) {
      const mine = a.slice(pi, i).join(' ')
      const theirs = b.slice(pj, j).join(' ')
      if (mine || theirs) {
        out.push({ mine, theirs, before: a.slice(Math.max(0, pi - 3), pi).join(' '),
                   at: [pi, i] })
      }
    }
    pi = i + 1
    pj = j + 1
  }
  return out.slice(0, max)
}

/** Replace one difference in the first reading with the other reading's text. */
export function applyChoice(first, diff, useTheirs) {
  if (!useTheirs) return first
  const a = tokens(first)
  const [s, e] = diff.at
  return [...a.slice(0, s), ...(diff.theirs ? [diff.theirs] : []), ...a.slice(e)].join(' ')
}
