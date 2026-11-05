import { useEffect, useState } from 'react'

/**
 * "The library changed" - a subject, module, question or set of notes was
 * added, edited or removed.
 *
 * Every screen that lists the library reads it on mount, which was enough when
 * nothing else could change it. It no longer is: an import writes a whole
 * question bank, the phone can be filing questions at the same time, and the
 * student expects what they just imported to be on the dashboard when they
 * look - not after a reload. So the views subscribe to this instead of
 * fetching once.
 *
 * The signal arrives two ways and both matter. Locally it is emitted the
 * moment a write returns, so the screen you are looking at updates without a
 * round trip. From the server it arrives over the workspace socket that is
 * already open, so another tab - or the phone - sees it too.
 */

let version = 0
const listeners = new Set()

export function bumpLibrary(reason = 'local') {
  version += 1
  for (const fn of listeners) {
    try { fn(version, reason) } catch { /* a bad listener must not stop the rest */ }
  }
}

export function onLibraryChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * A counter that increases whenever the library changes. Put it in a fetch
 * effect's dependency list and that fetch re-runs on every change.
 */
export function useLibraryVersion() {
  const [v, setV] = useState(version)
  useEffect(() => onLibraryChange(() => setV(version)), [])
  return v
}
