import React from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import App from './App'
import './styles.css'

const root = createRoot(document.getElementById('root'))
root.render(<App />)
invoke('log_debug', { msg: 'react mounted' }).catch(() => {})
