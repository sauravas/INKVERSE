// Voice input: microphone -> INKWISE /ws/speech -> whisperflow -> text.
import { useCallback, useEffect, useRef, useState } from 'react'

/** Microphones only work on https or localhost; a phone on http://LAN-IP cannot. */
export function voiceSupported() {
  return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode)
}

/**
 * Dictate into anything. While listening, onText(committed, partial) is called
 * with the words whisperflow is sure of plus the words it is still revising;
 * when the student stops (button, or a pause after speaking) onDone(text) fires.
 */
export function useDictation({ onText, onDone, subjectId, autoStopMs = 1800 } = {}) {
  const [state, setState] = useState('idle')   // idle|starting|listening|stopping|error
  const [error, setError] = useState(null)
  const [level, setLevel] = useState(0)
  const r = useRef({})
  const cb = useRef({ onText, onDone })
  cb.current = { onText, onDone }

  const cleanup = useCallback(() => {
    const c = r.current
    clearTimeout(c.quiet)
    clearInterval(c.drain)
    try { c.node?.disconnect() } catch { /* already gone */ }
    try { c.src?.disconnect() } catch { /* already gone */ }
    c.stream?.getTracks().forEach((t) => t.stop())
    c.ctx?.close().catch(() => {})
    r.current = { ws: c.ws }
    setLevel(0)
  }, [])

  const stop = useCallback(() => {
    const c = r.current
    if (!c.ws) return
    setState('stopping')
    cleanup()
    try { c.ws.send(JSON.stringify({ type: 'stop' })) } catch { /* closed */ }
  }, [cleanup])

  const start = useCallback(async () => {
    if (!voiceSupported()) {
      setError(window.isSecureContext ? 'This browser cannot record audio.'
        : 'Voice needs a secure page: use http://localhost on this laptop.')
      setState('error')
      return
    }
    setError(null); setState('starting')
    const c = { committed: '', partial: '', heard: false }
    r.current = c
    try {
      c.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      c.ctx = new AudioContext({ sampleRate: 16000 })
      await c.ctx.audioWorklet.addModule('/pcm-worklet.js')
      c.src = c.ctx.createMediaStreamSource(c.stream)
      c.node = new AudioWorkletNode(c.ctx, 'pcm-frames')
      c.src.connect(c.node)
    } catch (e) {
      cleanup()
      setError(e.name === 'NotAllowedError' ? 'Microphone permission was refused.' : e.message)
      setState('error')
      return
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/speech`
      + (subjectId ? `?subject_id=${encodeURIComponent(subjectId)}` : ''))
    ws.binaryType = 'arraybuffer'
    c.ws = ws
    const emit = () => cb.current.onText?.(c.committed, c.partial)
    // a pause after real speech ends the question, so no button press is needed
    const quietLater = () => {
      clearTimeout(c.quiet)
      if (c.heard && autoStopMs) c.quiet = setTimeout(stop, autoStopMs)
    }

    // The microphone is live before the voice service has said "ready" (it may
    // still be loading its model). Students start talking straight away, so
    // keep those first frames and send them once it is ready, instead of
    // dropping the start of the question.
    // Everything goes through one queue, drained at twice real time: whisperflow
    // segments speech by its timing, and a burst of seconds of audio at once
    // made it lose the start of the sentence.
    const queue = []
    c.ready = false
    c.node.port.onmessage = ({ data }) => {
      setLevel(data.level)
      if (queue.length < 300) queue.push(data.pcm)          // up to 30 s
    }
    c.drain = setInterval(() => {
      if (c.ready && queue.length && ws.readyState === WebSocket.OPEN) ws.send(queue.shift())
    }, 50)

    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.type === 'ready') {
        setState('listening')
        c.ready = true
      } else if (m.type === 'partial') {
        c.partial = m.text; c.heard ||= !!m.text; emit(); quietLater()
      } else if (m.type === 'final') {
        if (m.text) c.committed = `${c.committed} ${m.text}`.trim()
        c.partial = ''; emit(); quietLater()
      } else if (m.type === 'error') {
        setError(m.message); setState('error'); cleanup()
      } else if (m.type === 'end') {
        ws.close()
      }
    }
    ws.onclose = () => {
      cleanup()
      const text = `${c.committed} ${c.partial}`.trim()
      r.current = {}
      setState((s) => (s === 'error' ? s : 'idle'))
      if (text) cb.current.onDone?.(text)
    }
    ws.onerror = () => { setError('Could not reach the voice service.'); setState('error') }
  }, [cleanup, stop, subjectId, autoStopMs])

  useEffect(() => () => { stop(); cleanup() }, [stop, cleanup])

  const toggle = useCallback(() => {
    if (state === 'listening' || state === 'starting') stop()
    else start()
  }, [state, start, stop])

  return { state, error, level, start, stop, toggle, listening: state === 'listening' }
}
