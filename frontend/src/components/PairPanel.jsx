import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export default function PairPanel({ room, peers, status, latency, onClose }) {
  const [sess, setSess] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let dead = false
    api.pair(room)
      .then((s) => { if (!dead) setSess(s) })
      .catch((e) => { if (!dead) setErr(e.message) })
    return () => { dead = true }
  }, [room])

  const phones = peers.filter((p) => p.role === 'phone')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Connect your phone</h2>
            <p className="mt-0.5 text-sm text-ink-soft">
              Scan with your phone to use it as a writing pad.
            </p>
          </div>
          <button onClick={onClose}
                  className="rounded px-2 text-xl leading-none text-ink-soft hover:bg-slate-100">
            ×
          </button>
        </div>

        {err && (
          <p className="rounded bg-red-50 p-3 text-sm text-red-700">{err}</p>
        )}

        {sess && (
          <>
            <div className="flex justify-center rounded-lg border border-slate-200 p-3">
              <div className="h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
                   dangerouslySetInnerHTML={{ __html: sess.svg }} />
            </div>

            <div className="mt-4 space-y-2 text-sm">
              <Row label="Address">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px]">
                  {sess.url}
                </code>
              </Row>
              <Row label="Workspace">
                <code className="text-[12px]">{sess.room}</code>
              </Row>
              <Row label="Sync">
                <span className={status === 'live' ? 'text-emerald-700' : 'text-amber-700'}>
                  {status}{latency != null && status === 'live' ? ` · ${latency} ms` : ''}
                </span>
              </Row>
              <Row label="Phones">
                {phones.length
                  ? <span className="text-emerald-700">{phones.length} connected</span>
                  : <span className="text-ink-soft">none yet</span>}
              </Row>
            </div>

            <p className="mt-4 rounded bg-amber-50 p-3 text-[12px] leading-5 text-amber-900">
              Both devices must be on the same Wi-Fi. If the phone cannot open the
              page, your firewall may be blocking port {sess.port} — allow it for
              private networks.
            </p>
          </>
        )}

        {!sess && !err && (
          <div className="py-16 text-center text-sm text-ink-soft">Preparing…</div>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-soft">{label}</span>
      <span className="truncate text-right">{children}</span>
    </div>
  )
}
