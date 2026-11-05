// WebSocket workspace client.
//
// Deliberately free of any AI concern: strokes keep flowing while inference
// runs, and a dead backend only disables sync, never local writing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function wsUrl(room, role) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/${room}?role=${encodeURIComponent(role)}`
}

export function useWorkspace(room, role = 'laptop') {
  const [status, setStatus] = useState('connecting')
  const [peers, setPeers] = useState([])
  const [latency, setLatency] = useState(null)
  const sockRef = useRef(null)
  const handlers = useRef(new Set())
  const queue = useRef([])
  const retry = useRef(0)
  const alive = useRef(true)

  const on = useCallback((fn) => {
    handlers.current.add(fn)
    return () => handlers.current.delete(fn)
  }, [])

  const send = useCallback((msg) => {
    const s = sockRef.current
    if (s && s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify(msg))
    } else {
      // keep the most recent intent; stroke data is lossy by nature
      if (queue.current.length < 500) queue.current.push(msg)
    }
  }, [])

  useEffect(() => {
    if (!room) return
    alive.current = true
    let pingTimer = null

    const connect = () => {
      if (!alive.current) return
      setStatus(retry.current ? 'reconnecting' : 'connecting')
      let s
      try {
        s = new WebSocket(wsUrl(room, role))
      } catch {
        schedule()
        return
      }
      sockRef.current = s

      s.onopen = () => {
        retry.current = 0
        setStatus('live')
        const pending = queue.current.splice(0)
        for (const m of pending) s.send(JSON.stringify(m))
        pingTimer = setInterval(() => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({ t: 'ping', ts: performance.now() }))
          }
        }, 5000)
      }

      s.onmessage = (ev) => {
        let m
        try { m = JSON.parse(ev.data) } catch { return }
        if (m.t === 'pong') {
          setLatency(Math.round(performance.now() - m.ts))
          return
        }
        if (m.t === 'welcome' || m.t === 'peers') setPeers(m.peers || [])
        for (const fn of handlers.current) fn(m)
      }

      s.onclose = () => {
        if (pingTimer) clearInterval(pingTimer)
        sockRef.current = null
        if (alive.current) schedule()
      }
      s.onerror = () => { try { s.close() } catch { /* already closing */ } }
    }

    const schedule = () => {
      setStatus('offline')
      const wait = Math.min(8000, 400 * 2 ** retry.current++)
      setTimeout(() => { if (alive.current) connect() }, wait)
    }

    connect()
    return () => {
      alive.current = false
      if (pingTimer) clearInterval(pingTimer)
      const s = sockRef.current
      sockRef.current = null
      if (s) { s.onclose = null; try { s.close() } catch { /* noop */ } }
    }
  }, [room, role])

  // Stable identity matters: consumers put this object in effect deps, and a
  // fresh object every render re-runs those effects on every parent render.
  // send/on are already stable, so this only changes on real connection events.
  return useMemo(
    () => ({ status, peers, latency, send, on }),
    [status, peers, latency, send, on],
  )
}
