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

  // --- importing -----------------------------------------------------------
  importStatus: () => get('/api/import/status'),
  importExtract: async (file, kind = 'auto') => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', kind)
    // no JSON content-type: the browser sets the multipart boundary itself
    const r = await fetch('/api/import/extract', { method: 'POST', body: fd })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.detail || `${r.status} ${r.statusText}`)
    return body
  },
  importCommit: (b) => post('/api/import/commit', b),
  sources: (sid) => get(`/api/import/sources${sid ? `?subject_id=${sid}` : ''}`),
  deleteSource: (id) => del(`/api/import/sources/${id}`),

  // --- question-bank practice ----------------------------------------------
  practiceModule: (mid) => get(`/api/practice/module/${mid}`),
  practiceQuestion: (qid) => get(`/api/practice/question/${qid}`),
  saveAttempt: (qid, b) => jfetch(`/api/practice/question/${qid}/attempt`,
    { method: 'PUT', body: JSON.stringify(b) }),
  finishQuestion: (qid, outcome) =>
    post(`/api/practice/question/${qid}/finish`, { outcome }),

  // --- notes and sharing ---------------------------------------------------
  notes: (q) => get(`/api/notes?${new URLSearchParams(q)}`),
  share: (b) => post('/api/share', b),
  shares: () => get('/api/shares'),
  openShare: (token) => get(`/api/share/${token}`),
  revokeShare: (token) => del(`/api/share/${token}`),
  exportUrl: (q) => `/api/notes/export?${new URLSearchParams(q)}`,
  importBundle: (bundle, sharedBy) =>
    post('/api/notes/import', { bundle, shared_by: sharedBy || null }),

  // --- prepared study notes ------------------------------------------------
  noteModules: () => get('/api/study-notes/modules'),
  studyNotes: (mid) => get(`/api/study-notes/${mid}`),
  addMark: (noteId, b) => post(`/api/study-notes/notes/${noteId}/marks`, b),
  updateMark: (id, data) => patch(`/api/study-notes/marks/${id}`, { data }),
  deleteMark: (id) => del(`/api/study-notes/marks/${id}`),
}

/**
 * Stream a typed-event endpoint and fold it into steps as it arrives.
 * Handlers: onSteps(steps), onSources(items), onNotice(text), onDone(stats),
 * onError(err).
 * Returns an abort function.
 */
export function streamSteps(url, body, { onSteps, onSources, onNotice, onDone, onError, onEvent } = {}) {
  const acc = []
  return streamEvents(url, body, (ev) => {
    onEvent?.(ev)
    if (ev.type === 'sources') { onSources?.(ev.items || []); return }
    if (ev.type === 'notice') { onNotice?.(ev.message); return }
    if (ev.type === 'error') { onError?.(new Error(ev.message)); return }
    if (ev.type === 'done') { onDone?.({ ttft: ev.ttft_s, total: ev.total_s }); return }
    if (ev.type === 'step_open' || ev.type === 'segment') {
      acc.push(ev)
      onSteps?.(foldSteps(acc))
    }
  }, (e) => onError?.(e))
}

function foldSteps(events) {
  const steps = []
  let cur = null
  for (const e of events) {
    if (e.type === 'step_open') {
      cur = { index: e.index, title: e.title, final: e.final, segments: [] }
      steps.push(cur)
    } else if (e.type === 'segment' && cur) {
      cur.segments.push({ kind: e.kind, value: e.value, display: e.display,
                          ...(e.diagram ? { diagram: e.diagram } : {}),
                          ...(e.table ? { table: e.table } : {}) })
    }
  }
  return steps
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
