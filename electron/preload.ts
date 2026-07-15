import { contextBridge, ipcRenderer } from 'electron'

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

ipcRenderer.on('host-message', (_event, message) => {
  window.postMessage(message, '*')
})

// Drag & Drop file open (Feature 1.5)
// Exposed so the renderer can forward dropped file paths to the main process.
contextBridge.exposeInMainWorld('leandixApp', {
  dropFile: (filePath: string): void => {
    ipcRenderer.send('drop-file', filePath)
  },
})
