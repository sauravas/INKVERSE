import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PhoneApp from './PhoneApp'
import { SharedNotes } from './components/NotesView'
import './index.css'
import { calibrateLines } from './lib/lines'

// put the rules under the real handwriting baseline once the font has loaded
const calibrate = () => { try { window.__lines = calibrateLines() } catch { /* keep defaults */ } }
calibrate()
document.fonts?.ready.then(calibrate)

// One bundle, three entry points: the laptop app, the phone pad at /phone,
// and the read-only notes a friend opens from a share link at /notes/<token>.
const path = location.pathname.replace(/\/+$/, '')
const shared = path.match(/^\/notes\/([A-Za-z0-9_-]+)$/)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {path === '/phone' ? <PhoneApp />
      : shared ? <SharedNotes token={shared[1]} />
        : <App />}
  </StrictMode>,
)
