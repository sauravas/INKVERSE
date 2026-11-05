// REST + SSE client.
//
// streamEvents() consumes the backend's *typed* event stream. The model's raw
// text never arrives here; the UI only ever sees structured steps and segments.

async function jfetch(url, opts = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`
    try {
      const body = await r.json()
      if (body?.detail) detail = typeof body.detail === 'string'
        ? body.detail : JSON.stringify(body.detail)
    } catch { /* keep the status line */ }
    const err = new Error(detail)
    err.status = r.status
    throw err
  }
  return r.status === 204 ? null : r.json()
}

const get = (u) => jfetch(u)
const post = (u, body) => jfetch(u, { method: 'POST', body: JSON.stringify(body ?? {}) })
const patch = (u, body) => jfetch(u, { method: 'PATCH', body: JSON.stringify(body ?? {}) })
const del = (u) => jfetch(u, { method: 'DELETE' })

export const api = {
  status: () => get('/api/status'),

  providers: () => get('/api/ai/providers'),
  aiHealth: (p) => get(`/api/ai/health${p ? `?provider=${p}` : ''}`),
  memory: () => get('/api/ai/memory'),
  unload: (model) => post(`/api/ai/unload${model ? `?model=${encodeURIComponent(model)}` : ''}`),
  extract: (body) => post('/api/ai/extract', body),

  pair: (room) => post(`/api/pair/session${room ? `?room=${room}` : ''}`),
  pairInfo: (room) => get(`/api/pair/session/${room}`),

  saveRoom: (room) => post('/api/notebook/save', { room }),
  pages: () => get('/api/notebook/pages'),
  loadPage: (pid, room) => post(`/api/notebook/load/${pid}?room=${room}`),

  subjects: () => get('/api/study/subjects'),
  createSubject: (b) => post('/api/study/subjects', b),
  updateSubject: (id, b) => patch(`/api/study/subjects/${id}`, b),
  deleteSubject: (id) => del(`/api/study/subjects/${id}`),

  createModule: (b) => post('/api/study/modules', b),
  updateModule: (id, b) => patch(`/api/study/modules/${id}`, b),
  deleteModule: (id) => del(`/api/study/modules/${id}`),

  questions: (q = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v))
    return get(`/api/study/questions${p.toString() ? `?${p}` : ''}`)
  },
  question: (id) => get(`/api/study/questions/${id}`),
  createQuestion: (b) => post('/api/study/questions', b),
  updateQuestion: (id, b) => patch(`/api/study/questions/${id}`, b),
  deleteQuestion: (id) => del(`/api/study/questions/${id}`),
  recall: (id, correct) => post(`/api/study/questions/${id}/recall`, { correct }),

  dashboard: (sid) => get(`/api/study/dashboard${sid ? `?subject_id=${sid}` : ''}`),
}

/**
 * POST a JSON body and consume the SSE response.
 * `onEvent` receives decoded event objects. Returns an abort function.
 */
export function streamEvents(url, body, onEvent, onError) {
  const ctrl = new AbortController()

  ;(async () => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!r.ok) {
        let detail = `${r.status} ${r.statusText}`
        try {
          const j = await r.json()
          if (j?.detail) detail = j.detail
        } catch { /* keep status */ }
        onError?.(new Error(detail), r.status)
        return
      }

      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            try { onEvent(JSON.parse(payload)) } catch { /* skip bad frame */ }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') onError?.(e)
    }
  })()

  return () => ctrl.abort()
}
