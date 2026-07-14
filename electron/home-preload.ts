import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('homeApi', {
  onNetworkStatus: (cb: (online: boolean) => void) => {
    ipcRenderer.on('home-network-status', (_event, online: boolean) => cb(online))
  },
  openEditor: () => {
    ipcRenderer.send('home-action', { type: 'open-editor' })
  },
  openEditorNew: () => {
    ipcRenderer.send('home-action', { type: 'open-editor-new' })
  },
  openEditorWithFile: (filePath: string) => {
    ipcRenderer.send('home-action', { type: 'open-editor', filePath })
  },
  openAtlasWeb: () => {
    ipcRenderer.send('home-action', { type: 'open-atlas-web' })
  },
  onLanguage: (cb: (lang: string) => void) => {
    ipcRenderer.on('home-language', (_event, lang: string) => cb(lang))
  },
  toggleLanguage: () => {
    ipcRenderer.send('home-action', { type: 'toggle-language' })
  },
  getRecentFiles: (): Promise<Array<{ filePath: string; title: string; lastOpenedAt: string }>> => {
    return ipcRenderer.invoke('get-recent-files')
  },
})
