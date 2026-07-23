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
  openEditorFromTemplate: (templateId: string) => {
    ipcRenderer.send('home-action', { type: 'open-editor-template', templateId })
  },
  openAtlasWeb: () => {
    ipcRenderer.send('home-action', { type: 'open-atlas-web' })
  },
  /** Start network check before opening Atlas Web. Main process replies via onAtlasWebCheckResult. */
  checkNetworkForAtlas: () => {
    ipcRenderer.send('check-network-for-atlas')
  },
  /** Cancel an in-progress network check. */
  cancelAtlasWebCheck: () => {
    ipcRenderer.send('cancel-atlas-web-check')
  },
  /** Listen for the result of the Atlas Web network check. */
  onAtlasWebCheckResult: (cb: (result: { status: 'online' | 'offline' | 'cancelled' }) => void) => {
    ipcRenderer.once('atlas-web-check-result', (_event, result) => cb(result))
  },
  onLanguage: (cb: (lang: string) => void) => {
    ipcRenderer.on('home-language', (_event, lang: string) => cb(lang))
  },
  onTheme: (cb: (theme: string) => void) => {
    ipcRenderer.on('home-theme', (_event, theme: string) => cb(theme))
  },
  getSettings: (): Promise<{ language: 'vi' | 'en'; theme: 'dark' | 'light' }> => {
    return ipcRenderer.invoke('get-settings')
  },
  applySettings: (settings: { language: 'vi' | 'en'; theme: 'dark' | 'light' }) => {
    ipcRenderer.send('apply-settings', settings)
  },
  openFileDialog: (): Promise<string | null> => {
    return ipcRenderer.invoke('open-file-dialog-from-home')
  },
  openPdfDialog: (): Promise<string | null> => {
    return ipcRenderer.invoke('open-pdf-dialog-from-home')
  },
  getRecentFiles: (): Promise<Array<{ filePath: string; title: string; lastOpenedAt: string }>> => {
    return ipcRenderer.invoke('get-recent-files')
  },
})
