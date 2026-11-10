import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DownloadInfoWindow } from './components/DownloadInfoWindow'
import { ProgressWindow } from './components/ProgressWindow'
import './index.css'

// The same bundle serves the main window and the standalone dialog windows (?view=...).
const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const id = params.get('id') ?? ''

const root =
  view === 'dlinfo' ? <DownloadInfoWindow id={id} /> :
  view === 'progress' ? <ProgressWindow id={id} /> :
  <App />

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{root}</React.StrictMode>)
