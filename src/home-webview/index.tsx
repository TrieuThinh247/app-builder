import React from 'react'
import { createRoot } from 'react-dom/client'
import HomeApp from './HomeApp'
import './home.css'

const root = createRoot(document.getElementById('root')!)
root.render(<HomeApp />)
