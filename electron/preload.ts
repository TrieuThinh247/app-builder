import { contextBridge, ipcRenderer } from 'electron'
import * as path from 'path'

const vscodeShim = {
  postMessage: (message: unknown): void => {
    ipcRenderer.send('vscode-message', message)
  },
  getState: (): unknown => {
    const stored = localStorage.getItem('vscode-state')
    return stored ? JSON.parse(stored) : null
  },
  setState: (state: unknown): void => {
    localStorage.setItem('vscode-state', JSON.stringify(state))
  },
}

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => vscodeShim)

const pdfWorkerPath = path.join(__dirname, '..', 'pdf-webview', 'pdf.worker.min.mjs')
const pdfWorkerUrl = `file://${pdfWorkerPath.replace(/\\/g, '/')}`
contextBridge.exposeInMainWorld('__PDF_WORKER_URL__', pdfWorkerUrl)

ipcRenderer.on('host-message', (_event, message) => {
  window.postMessage(message, '*')
})
