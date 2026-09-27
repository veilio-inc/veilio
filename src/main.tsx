import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'
import { initTheme } from './lib/theme.js'
import { dropLegacyPlaintextMaps } from './lib/localMapStore.js'
import './global.css'

// Before the first render, not in an effect: an effect runs after the first
// paint, so a user who chose light would see one dark frame on every load.
initTheme()
// Plaintext symbol maps from builds before spec 018: deleted, not migrated.
dropLegacyPlaintextMaps()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
