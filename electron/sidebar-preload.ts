import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('sidebarApi', {
  sendAction: (action: string) => {
    ipcRenderer.send('sidebar-action', action)
  },
})
