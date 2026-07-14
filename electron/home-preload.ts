import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('homeApi', {
  onNetworkStatus: (cb: (online: boolean) => void) => {
    ipcRenderer.on('home-network-status', (_event, online: boolean) => cb(online))
  },
  openEditor: () => {
    ipcRenderer.send('home-action', { type: 'open-editor' })
  },
  openAtlasWeb: () => {
    ipcRenderer.send('home-action', { type: 'open-atlas-web' })
  },
})
