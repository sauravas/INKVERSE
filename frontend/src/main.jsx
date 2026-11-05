import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PhoneApp from './PhoneApp'
import { SharedNotes } from './components/NotesView'
import './index.css'

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
