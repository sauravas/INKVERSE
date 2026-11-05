import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PhoneApp from './PhoneApp'
import './index.css'

// Two entry points, one bundle: the phone companion lives at /phone.
const isPhone = location.pathname.replace(/\/+$/, '') === '/phone'

createRoot(document.getElementById('root')).render(
  <StrictMode>{isPhone ? <PhoneApp /> : <App />}</StrictMode>,
)
