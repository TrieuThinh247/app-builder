import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tabBarApi', {
  ready: () => ipcRenderer.send('tab-bar-ready'),
  createTab: () => ipcRenderer.send('tab-create'),
  closeTab: (tabId: string) => ipcRenderer.send('tab-close', { tabId }),
  switchTab: (tabId: string) => ipcRenderer.send('tab-switch', { tabId }),
  respondOpenMode: (mode: 'new' | 'replace') => ipcRenderer.send('tab-open-mode', { mode }),
  onTabState: (cb: (tabs: unknown[]) => void) =>
    ipcRenderer.on('tab-state', (_e, tabs) => cb(tabs)),
  onAskOpenMode: (cb: () => void) =>
    ipcRenderer.on('tab-open-mode-prompt', () => cb()),
  onLanguage: (cb: (lang: string) => void) =>
    ipcRenderer.on('tab-bar-language', (_e, lang) => cb(lang)),
})
