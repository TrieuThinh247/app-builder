import { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as os from 'os'
import * as dns from 'dns'
import { execFile } from 'child_process'
import { parseDocx } from '../../extension/src/extension/DocxParser'
import { serializeToDocx } from '../../extension/src/extension/DocxSerializer'
import { DEFAULT_PAGE_SETTINGS } from '../../extension/src/shared/constants'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface AppSettings {
  language: 'vi' | 'en'
  theme: 'dark' | 'light'
}

const DEFAULT_SETTINGS: AppSettings = { language: 'vi', theme: 'dark' }

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): AppSettings {
  try {
    const raw = fsSync.readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      language: parsed.language === 'en' ? 'en' : 'vi',
      theme: parsed.theme === 'light' ? 'light' : 'dark',
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(settings: AppSettings): void {
  try {
    fsSync.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch {
    // ignore write errors
  }
}

// ---------------------------------------------------------------------------
// Recent Files
// ---------------------------------------------------------------------------

interface RecentFileEntry {
  filePath: string
  title: string
  lastOpenedAt: string // ISO string
}

const MAX_RECENT_FILES = 20

function getRecentFilesPath(): string {
  return path.join(app.getPath('userData'), 'recent-files.json')
}

function loadRecentFiles(): RecentFileEntry[] {
  try {
    const raw = fsSync.readFileSync(getRecentFilesPath(), 'utf-8')
    return JSON.parse(raw) as RecentFileEntry[]
  } catch {
    return []
  }
}

function saveRecentFiles(entries: RecentFileEntry[]): void {
  try {
    fsSync.writeFileSync(getRecentFilesPath(), JSON.stringify(entries, null, 2), 'utf-8')
  } catch {
    // ignore write errors
  }
}

function addRecentFile(filePath: string): void {
  let entries = loadRecentFiles()
  // Remove existing entry for this path
  entries = entries.filter((e) => e.filePath !== filePath)
  entries.unshift({
    filePath,
    title: path.basename(filePath),
    lastOpenedAt: new Date().toISOString(),
  })
  if (entries.length > MAX_RECENT_FILES) entries = entries.slice(0, MAX_RECENT_FILES)
  saveRecentFiles(entries)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Comment = {
  id: string
  author: string
  date: string
  text: string
  rangeStart: number
  rangeEnd: number
  replies?: Array<{ id: string; author: string; date: string; text: string }>
}

type FileExtras = {
  headerHtml?: string
  footerHtml?: string
  comments?: Comment[]
  pageSettings?: typeof DEFAULT_PAGE_SETTINGS
  defaultFont?: string
  defaultFontSize?: number
}

interface TabDocumentState {
  currentFilePath: string | null
  fileContentHtml: string
  fileExtras: FileExtras
}

interface Tab {
  id: string
  type: 'editor' | 'pdf'
  title: string
  documentState: TabDocumentState
  isDirty: boolean
  view: WebContentsView
}

interface TabStateSnapshot {
  id: string
  title: string
  type: 'editor' | 'pdf'
  isDirty: boolean
  isActive: boolean
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let homeWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let atlasWindow: BrowserWindow | null = null

const tabs = new Map<string, Tab>()
let activeTabId: string | null = null
let tabBarView: WebContentsView | null = null

let pendingOpenFilePath: string | null = null

/** File path to open when the first editor window is created */
let pendingInitialFilePath: string | null = null

const _initialSettings = loadSettings()
/** Current UI language */
let currentLanguage: 'vi' | 'en' = _initialSettings.language
/** Current UI theme */
let currentTheme: 'dark' | 'light' = _initialSettings.theme

// ---------------------------------------------------------------------------
// Layout Helpers
// ---------------------------------------------------------------------------

const TAB_BAR_HEIGHT = 36

function getTabBarBounds(win: BrowserWindow): { x: number; y: number; width: number; height: number } {
  const [width] = win.getContentSize()
  return { x: 0, y: 0, width, height: TAB_BAR_HEIGHT }
}

function getContentBounds(win: BrowserWindow): { x: number; y: number; width: number; height: number } {
  const [width, height] = win.getContentSize()
  return { x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) }
}

function updateLayout(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (tabBarView) tabBarView.setBounds(getTabBarBounds(mainWindow))
  if (activeTabId) {
    const tab = tabs.get(activeTabId)
    if (tab) tab.view.setBounds(getContentBounds(mainWindow))
  }
}

// ---------------------------------------------------------------------------
// Tab State
// ---------------------------------------------------------------------------

function pushTabState(): void {
  if (!tabBarView || tabBarView.webContents.isDestroyed()) return
  const snapshots: TabStateSnapshot[] = []
  for (const tab of tabs.values()) {
    snapshots.push({
      id: tab.id,
      title: tab.title,
      type: tab.type,
      isDirty: tab.isDirty,
      isActive: tab.id === activeTabId,
    })
  }
  tabBarView.webContents.send('tab-state', snapshots)
}

// ---------------------------------------------------------------------------
// Window Creation
// ---------------------------------------------------------------------------

function checkNetwork(): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup('atlas.leandix.com', (err) => resolve(!err))
  })
}

function createHomeWindow(): void {
  homeWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 500,
    resizable: true,
    center: true,
    title: 'Leandix Atlas',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'home-preload.js'),
    },
  })

  homeWindow.loadFile(path.join(__dirname, '..', 'home-webview', 'index.html'))
  homeWindow.setMenuBarVisibility(false)

  homeWindow.webContents.once('did-finish-load', () => {
    void checkNetwork().then((online) => {
      homeWindow?.webContents.send('home-network-status', online)
      homeWindow?.webContents.send('home-language', currentLanguage)
      homeWindow?.webContents.send('home-theme', currentTheme)

      // If offline, go straight to editor after brief delay so user sees the screen
      if (!online) {
        setTimeout(() => {
          openEditorFromHome()
        }, 1500)
      }
    })
  })

  homeWindow.on('closed', () => {
    homeWindow = null
  })
}

function openEditorFromHome(filePath?: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    homeWindow?.close()
    if (filePath) {
      const ext = path.extname(filePath).toLowerCase()
      if (ext === '.pdf') createPdfTab(filePath)
      else createEditorTab(filePath)
    }
    return
  }
  createWindow(filePath)
  homeWindow?.close()
}

function openAtlasWebWindow(): void {
  if (atlasWindow && !atlasWindow.isDestroyed()) {
    atlasWindow.show()
    atlasWindow.focus()
    homeWindow?.close()
    return
  }

  atlasWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Atlas Web — Leandix',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Allow the embedded page to run normally
      webSecurity: true,
    },
  })

  atlasWindow.loadURL('https://atlas.leandix.com')
  atlasWindow.setMenuBarVisibility(false)

  const atlasMenu = Menu.buildFromTemplate([
    {
      label: 'Điều hướng',
      submenu: [
        {
          label: 'Trang chủ',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            if (homeWindow && !homeWindow.isDestroyed()) {
              homeWindow.show()
              homeWindow.focus()
            } else {
              createHomeWindow()
            }
          },
        },
        {
          label: 'Mở Editor',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show()
              mainWindow.focus()
            } else {
              createWindow()
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Thoát',
          role: 'quit',
        },
      ],
    },
  ])
  atlasWindow.setMenu(atlasMenu)
  atlasWindow.setMenuBarVisibility(true)

  atlasWindow.on('closed', () => {
    atlasWindow = null
  })

  homeWindow?.close()
}

// ---------------------------------------------------------------------------
// Tab Creation / Activation
// ---------------------------------------------------------------------------

function createEditorTab(filePath?: string): string {
  if (!mainWindow || mainWindow.isDestroyed()) return ''
  const id = crypto.randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  view.webContents.loadFile(path.join(__dirname, '..', 'webview', 'index.html'))

  const tab: Tab = {
    id,
    type: 'editor',
    title: filePath ? path.basename(filePath) : 'Tài liệu mới',
    documentState: { currentFilePath: filePath ?? null, fileContentHtml: '', fileExtras: {} },
    isDirty: false,
    view,
  }
  tabs.set(id, tab)
  mainWindow.contentView.addChildView(view)

  // Hide until activated
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

  view.webContents.once('did-finish-load', () => {
    // Send current theme and language so editor starts with correct settings
    view.webContents.send('host-message', { type: 'theme', payload: { theme: currentTheme } })
    view.webContents.send('host-message', { type: 'language', payload: { language: currentLanguage } })
    if (filePath) {
      void loadAndSendFileToTab(id, filePath)
    }
  })

  setActiveTab(id)
  return id
}

function createPdfTab(filePath: string): string {
  if (!mainWindow || mainWindow.isDestroyed()) return ''
  const id = crypto.randomUUID()

  const pdfjsRoot = path.join(__dirname, '..', 'pdfjs')
  const viewerHtmlPath = path.join(pdfjsRoot, 'web', 'viewer.html')
  const buildBase = path.join(pdfjsRoot, 'build').replace(/\\/g, '/')
  const pdfFileUrl = `file:///${filePath.replace(/\\/g, '/')}`
  const workerSrc = `file:///${buildBase}/pdf.worker.mjs`
  const sandboxSrc = `file:///${buildBase}/pdf.sandbox.mjs`

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  })
  view.webContents.loadFile(viewerHtmlPath)

  view.webContents.once('did-finish-load', () => {
    view.webContents.executeJavaScript(`
      if (typeof PDFViewerApplicationOptions !== 'undefined') {
        PDFViewerApplicationOptions.set('defaultUrl', '${pdfFileUrl.replace(/'/g, "\\'")}');
        PDFViewerApplicationOptions.set('workerSrc', '${workerSrc}');
        PDFViewerApplicationOptions.set('sandboxBundleSrc', '${sandboxSrc}');
        PDFViewerApplicationOptions.set('disablePreferences', true);
        if (typeof PDFViewerApplication !== 'undefined' && PDFViewerApplication.open) {
          PDFViewerApplication.open({ url: '${pdfFileUrl.replace(/'/g, "\\'")}' });
        }
      }
    `).catch(console.error)
  })

  const tab: Tab = {
    id,
    type: 'pdf',
    title: path.basename(filePath),
    documentState: { currentFilePath: filePath, fileContentHtml: '', fileExtras: {} },
    isDirty: false,
    view,
  }
  tabs.set(id, tab)
  mainWindow.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

  setActiveTab(id)
  return id
}

function setActiveTab(id: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const tab = tabs.get(id)
  if (!tab) return

  // Hide previous active tab
  if (activeTabId && activeTabId !== id) {
    const prev = tabs.get(activeTabId)
    if (prev) prev.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  }

  activeTabId = id
  tab.view.setBounds(getContentBounds(mainWindow))
  pushTabState()
}

// ---------------------------------------------------------------------------
// Tab Close / Open Flow
// ---------------------------------------------------------------------------

async function confirmUnsavedChangesForTab(tab: Tab): Promise<'save' | 'discard' | 'cancel'> {
  if (!mainWindow || mainWindow.isDestroyed()) return 'discard'
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: currentLanguage === 'vi' ? 'Tài liệu chưa lưu' : 'Unsaved document',
    message: currentLanguage === 'vi'
      ? `"${tab.title}" có thay đổi chưa lưu. Bạn có muốn lưu không?`
      : `"${tab.title}" has unsaved changes. Do you want to save?`,
    buttons: currentLanguage === 'vi' ? ['Lưu', 'Không lưu', 'Hủy'] : ['Save', 'Don\'t save', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })
  if (response === 0) return 'save'
  if (response === 1) return 'discard'
  return 'cancel'
}

async function closeTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab) return

  if (tab.isDirty) {
    const action = await confirmUnsavedChangesForTab(tab)
    if (action === 'cancel') return
    if (action === 'save') await saveTabFile(tabId)
  }

  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.contentView.removeChildView(tab.view)
  tab.view.webContents.close()
  tabs.delete(tabId)

  if (activeTabId === tabId) {
    activeTabId = null
    const remaining = [...tabs.keys()]
    if (remaining.length > 0) {
      setActiveTab(remaining[remaining.length - 1])
    } else {
      // No tabs left — go back to home screen
      if (homeWindow && !homeWindow.isDestroyed()) {
        homeWindow.show()
        homeWindow.focus()
      } else {
        createHomeWindow()
      }
      mainWindow?.destroy()
      return
    }
  }

  pushTabState()
}

async function openFileInTab(filePath: string, mode: 'new' | 'replace'): Promise<void> {
  const ext = path.extname(filePath).toLowerCase()

  if (mode === 'new') {
    if (ext === '.pdf') {
      createPdfTab(filePath)
    } else {
      createEditorTab(filePath)
    }
    return
  }

  // replace mode
  if (!activeTabId) {
    if (ext === '.pdf') createPdfTab(filePath)
    else createEditorTab(filePath)
    return
  }

  const activeTab = tabs.get(activeTabId)
  if (!activeTab) return

  if (activeTab.isDirty) {
    const action = await confirmUnsavedChangesForTab(activeTab)
    if (action === 'cancel') return
    if (action === 'save') await saveTabFile(activeTabId)
  }

  if (ext === '.pdf') {
    // Replace with a new pdf tab, remove old
    const oldId = activeTabId
    createPdfTab(filePath)
    const old = tabs.get(oldId)
    if (old && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(old.view)
      old.view.webContents.close()
      tabs.delete(oldId)
    }
  } else {
    activeTab.title = path.basename(filePath)
    activeTab.documentState.currentFilePath = filePath
    activeTab.documentState.fileContentHtml = ''
    activeTab.documentState.fileExtras = {}
    activeTab.isDirty = false
    pushTabState()
    await loadAndSendFileToTab(activeTabId, filePath)
  }
}

// ---------------------------------------------------------------------------
// Per-tab File Loading / Saving / Message Handling
// ---------------------------------------------------------------------------

async function loadAndSendFileToTab(tabId: string, filePath: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab) return

  try {
    const buffer = await fs.readFile(filePath)
    const parsed = await parseDocx(buffer as unknown as Buffer)
    addRecentFile(filePath)

    tab.documentState.currentFilePath = filePath
    tab.documentState.fileContentHtml = parsed.bodyHtml
    tab.documentState.fileExtras = {
      headerHtml: parsed.headerHtml,
      footerHtml: parsed.footerHtml,
      comments: parsed.comments,
      pageSettings: parsed.pageSettings || DEFAULT_PAGE_SETTINGS,
      defaultFont: parsed.metadata?.defaultFont ?? undefined,
      defaultFontSize: parsed.metadata?.defaultFontSize ?? undefined,
    }

    tab.view.webContents.send('host-message', {
      type: 'load',
      payload: {
        html: parsed.bodyHtml,
        headerHtml: parsed.headerHtml,
        footerHtml: parsed.footerHtml,
        comments: parsed.comments,
        warnings: parsed.warnings,
        pageSettings: parsed.pageSettings || DEFAULT_PAGE_SETTINGS,
        language: currentLanguage,
        metadata: {
          defaultFont: parsed.metadata?.defaultFont ?? 'Times New Roman',
          defaultFontSize: parsed.metadata?.defaultFontSize ?? 13,
        },
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi mở file', message)
  }
}

async function saveTabFile(tabId: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return

  if (tab.documentState.currentFilePath === null) {
    await saveTabFileAs(tabId)
    return
  }

  try {
    const { fileExtras } = tab.documentState
    const buffer = await serializeToDocx(tab.documentState.fileContentHtml, {
      headerHtml: fileExtras.headerHtml,
      footerHtml: fileExtras.footerHtml,
      comments: fileExtras.comments,
      pageSettings: fileExtras.pageSettings,
      defaultFont: fileExtras.defaultFont,
      defaultFontSize: fileExtras.defaultFontSize,
    })
    await fs.writeFile(tab.documentState.currentFilePath, buffer)
    tab.isDirty = false
    tab.view.webContents.send('host-message', { type: 'saved', payload: {} })
    pushTabState()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi lưu file', message)
  }
}

async function saveTabFileAs(tabId: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return

  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Word Documents', extensions: ['docx'] }],
  })
  if (result.canceled || !result.filePath) return

  try {
    const { fileExtras } = tab.documentState
    const buffer = await serializeToDocx(tab.documentState.fileContentHtml, {
      headerHtml: fileExtras.headerHtml,
      footerHtml: fileExtras.footerHtml,
      comments: fileExtras.comments,
      pageSettings: fileExtras.pageSettings,
      defaultFont: fileExtras.defaultFont,
      defaultFontSize: fileExtras.defaultFontSize,
    })
    await fs.writeFile(result.filePath, buffer)
    tab.documentState.currentFilePath = result.filePath
    tab.title = path.basename(result.filePath)
    tab.isDirty = false
    addRecentFile(result.filePath)
    tab.view.webContents.send('host-message', { type: 'saved', payload: {} })
    pushTabState()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi lưu file', message)
  }
}

async function handleVsCodeMessageForTab(tabId: string, message: unknown): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab) return
  if (!message || typeof message !== 'object') return
  const msg = message as { type?: unknown; payload?: unknown }
  if (typeof msg.type !== 'string') return

  switch (msg.type) {
    case 'ready': {
      if (tab.type === 'pdf') {
        const fileUrl = `file:///${tab.documentState.currentFilePath!.replace(/\\/g, '/')}`
        tab.view.webContents.send('host-message', { type: 'load-pdf-url', payload: { url: fileUrl } })
        tab.view.webContents.send('host-message', { type: 'language', payload: { language: currentLanguage } })
        break
      }
      if (tab.documentState.currentFilePath) {
        await loadAndSendFileToTab(tabId, tab.documentState.currentFilePath)
      } else {
        tab.view.webContents.send('host-message', {
          type: 'load',
          payload: {
            html: '',
            warnings: [],
            headerHtml: '',
            footerHtml: '',
            comments: [],
            pageSettings: DEFAULT_PAGE_SETTINGS,
            language: currentLanguage,
            metadata: { defaultFont: 'Aptos', defaultFontSize: 12 },
          },
        })
      }
      break
    }

    case 'update': {
      const payload = msg.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== 'object') return
      if (
        typeof payload.html !== 'string' ||
        typeof payload.headerHtml !== 'string' ||
        typeof payload.footerHtml !== 'string' ||
        !Array.isArray(payload.comments) ||
        !payload.pageSettings ||
        typeof payload.pageSettings !== 'object'
      ) return
      tab.documentState.fileContentHtml = payload.html
      tab.documentState.fileExtras = {
        headerHtml: payload.headerHtml as string,
        footerHtml: payload.footerHtml as string,
        comments: payload.comments as Comment[],
        pageSettings: payload.pageSettings as typeof DEFAULT_PAGE_SETTINGS,
        defaultFont: typeof payload.defaultFont === 'string' ? payload.defaultFont : tab.documentState.fileExtras.defaultFont,
        defaultFontSize: typeof payload.defaultFontSize === 'number' ? payload.defaultFontSize : tab.documentState.fileExtras.defaultFontSize,
      }
      break
    }

    case 'save': {
      const payload = msg.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== 'object') return
      if (
        typeof payload.html !== 'string' ||
        typeof payload.headerHtml !== 'string' ||
        typeof payload.footerHtml !== 'string' ||
        !Array.isArray(payload.comments) ||
        !payload.pageSettings ||
        typeof payload.pageSettings !== 'object'
      ) return
      tab.documentState.fileContentHtml = payload.html
      tab.documentState.fileExtras = {
        headerHtml: payload.headerHtml as string,
        footerHtml: payload.footerHtml as string,
        comments: payload.comments as Comment[],
        pageSettings: payload.pageSettings as typeof DEFAULT_PAGE_SETTINGS,
        defaultFont: typeof payload.defaultFont === 'string' ? payload.defaultFont : tab.documentState.fileExtras.defaultFont,
        defaultFontSize: typeof payload.defaultFontSize === 'number' ? payload.defaultFontSize : tab.documentState.fileExtras.defaultFontSize,
      }
      await saveTabFile(tabId)
      break
    }

    case 'requestLocalImage': {
      await handleRequestLocalImage(tab.view.webContents)
      break
    }

    case 'dirtyStateChanged': {
      const payload = msg.payload as Record<string, unknown> | undefined
      if (payload && typeof payload.isDirty === 'boolean') {
        tab.isDirty = payload.isDirty
        pushTabState()
      }
      break
    }

    case 'toggleLanguage': {
      currentLanguage = currentLanguage === 'vi' ? 'en' : 'vi'
      for (const t of tabs.values()) {
        if (!t.view.webContents.isDestroyed()) {
          t.view.webContents.send('host-message', { type: 'language', payload: { language: currentLanguage } })
        }
      }
      // Rebuild native app menu in new language
      createAppMenu()
      // Push language to tab bar
      if (tabBarView && !tabBarView.webContents.isDestroyed()) {
        tabBarView.webContents.send('tab-bar-language', currentLanguage)
      }
      break
    }

    default:
      break
  }
}

function createWindow(initialFilePath?: string): void {
  pendingInitialFilePath = initialFilePath ?? null
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Set up tab bar view
  tabBarView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'tab-bar-preload.js'),
    },
  })
  mainWindow.contentView.addChildView(tabBarView)
  tabBarView.webContents.loadFile(path.join(__dirname, '..', 'tab-bar', 'index.html'))
  tabBarView.setBounds(getTabBarBounds(mainWindow))

  mainWindow.on('resize', updateLayout)

  createAppMenu()

  mainWindow.on('close', (event) => {
    const dirtyTabs = [...tabs.values()].filter((t) => t.isDirty)
    if (dirtyTabs.length === 0) return
    event.preventDefault()
    void (async () => {
      for (const tab of dirtyTabs) {
        const action = await confirmUnsavedChangesForTab(tab)
        if (action === 'cancel') return
        if (action === 'save') await saveTabFile(tab.id)
      }
      mainWindow?.destroy()
    })()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    tabBarView = null
    // Re-open home if no other windows remain
    if (!homeWindow || homeWindow.isDestroyed()) {
      createHomeWindow()
    } else {
      homeWindow.show()
      homeWindow.focus()
    }
  })
}

// ---------------------------------------------------------------------------
// IPC Message Dispatch (Task 3.2) — registered in app.whenReady()
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle('open-file-dialog-from-home', async () => {
    if (!homeWindow || homeWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(homeWindow, {
      filters: [
        { name: currentLanguage === 'vi' ? 'Tài liệu được hỗ trợ' : 'Supported files', extensions: ['docx', 'pdf'] },
        { name: 'Word Documents', extensions: ['docx'] },
        { name: 'PDF Files', extensions: ['pdf'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('open-pdf-dialog-from-home', async () => {
    if (!homeWindow || homeWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(homeWindow, {
      filters: [
        { name: 'PDF Files', extensions: ['pdf'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('get-recent-files', () => {
    return loadRecentFiles()
  })

  ipcMain.handle('get-settings', () => {
    return { language: currentLanguage, theme: currentTheme }
  })

  ipcMain.on('apply-settings', (_event, settings: { language: 'vi' | 'en'; theme: 'dark' | 'light' }) => {
    currentLanguage = settings.language
    currentTheme = settings.theme
    saveSettings({ language: currentLanguage, theme: currentTheme })

    // Broadcast language to all surfaces
    if (homeWindow && !homeWindow.isDestroyed()) {
      homeWindow.webContents.send('home-language', currentLanguage)
      homeWindow.webContents.send('home-theme', currentTheme)
    }
    for (const t of tabs.values()) {
      if (!t.view.webContents.isDestroyed()) {
        t.view.webContents.send('host-message', { type: 'language', payload: { language: currentLanguage } })
        t.view.webContents.send('host-message', { type: 'theme', payload: { theme: currentTheme } })
      }
    }
    if (tabBarView && !tabBarView.webContents.isDestroyed()) {
      tabBarView.webContents.send('tab-bar-language', currentLanguage)
      tabBarView.webContents.send('tab-bar-theme', currentTheme)
    }
    createAppMenu()
  })

  ipcMain.on('home-action', (_event, message: { type: string; filePath?: string }) => {
    if (message.type === 'open-editor') {
      openEditorFromHome(message.filePath)
    } else if (message.type === 'open-editor-new') {
      openEditorFromHome()
    } else if (message.type === 'open-atlas-web') {
      openAtlasWebWindow()
    } else if (message.type === 'toggle-language') {
      currentLanguage = currentLanguage === 'vi' ? 'en' : 'vi'
      // Update home window
      if (homeWindow && !homeWindow.isDestroyed()) {
        homeWindow.webContents.send('home-language', currentLanguage)
      }
      // Update all editor tabs
      for (const t of tabs.values()) {
        if (!t.view.webContents.isDestroyed()) {
          t.view.webContents.send('host-message', { type: 'language', payload: { language: currentLanguage } })
        }
      }
      // Update tab bar
      if (tabBarView && !tabBarView.webContents.isDestroyed()) {
        tabBarView.webContents.send('tab-bar-language', currentLanguage)
      }
      // Rebuild native app menu
      createAppMenu()
    }
  })

  ipcMain.on('vscode-message', (event, message) => {
    const tab = [...tabs.values()].find((t) => t.view.webContents === event.sender)
    if (tab) {
      void handleVsCodeMessageForTab(tab.id, message)
    }
  })

  ipcMain.on('tab-bar-ready', () => {
    if (tabs.size === 0) {
      const p = pendingInitialFilePath
      pendingInitialFilePath = null
      if (p) {
        const ext = path.extname(p).toLowerCase()
        if (ext === '.pdf') createPdfTab(p)
        else createEditorTab(p)
      } else {
        createEditorTab()
      }
    } else {
      pushTabState()
    }
    if (tabBarView && !tabBarView.webContents.isDestroyed()) {
      tabBarView.webContents.send('tab-bar-language', currentLanguage)
      tabBarView.webContents.send('tab-bar-theme', currentTheme)
    }
  })

  ipcMain.on('tab-create', () => {
    createEditorTab()
  })

  ipcMain.on('tab-close', (_event, { tabId }: { tabId: string }) => {
    void closeTab(tabId)
  })

  ipcMain.on('tab-switch', (_event, { tabId }: { tabId: string }) => {
    setActiveTab(tabId)
  })

  ipcMain.on('tab-open-mode', (_event, { mode }: { mode: 'new' | 'replace' }) => {
    if (pendingOpenFilePath) {
      const p = pendingOpenFilePath
      pendingOpenFilePath = null
      void openFileInTab(p, mode)
    }
  })
}


// ---------------------------------------------------------------------------
// File Open Dialog
// ---------------------------------------------------------------------------

async function showOpenFileDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Supported Files', extensions: ['docx', 'pdf'] },
      { name: 'Word Documents', extensions: ['docx'] },
      { name: 'PDF Files', extensions: ['pdf'] },
    ],
    properties: ['openFile'],
  })

  if (result.canceled || result.filePaths.length === 0) return

  const filePath = result.filePaths[0]

  if (tabs.size === 0) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.pdf') createPdfTab(filePath)
    else createEditorTab(filePath)
    return
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: currentLanguage === 'vi' ? 'Mở file' : 'Open file',
    message: currentLanguage === 'vi'
      ? `Mở "${path.basename(filePath)}" trong:`
      : `Open "${path.basename(filePath)}" in:`,
    buttons: currentLanguage === 'vi'
      ? ['Tab mới', 'Thay thế tab hiện tại', 'Hủy']
      : ['New tab', 'Replace current tab', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })

  if (response === 2) return
  void openFileInTab(filePath, response === 0 ? 'new' : 'replace')
}

// ---------------------------------------------------------------------------
// Local Image Insertion
// ---------------------------------------------------------------------------

async function handleRequestLocalImage(webContents: Electron.WebContents): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    properties: ['openFile'],
  })

  if (result.canceled || result.filePaths.length === 0) return

  const filePath = result.filePaths[0]

  try {
    const buffer = await fs.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    webContents.send('host-message', {
      type: 'localImageResult',
      payload: { success: true, base64Data: `data:${mime};base64,${buffer.toString('base64')}`, fileName: path.basename(filePath) },
    })
  } catch {
    webContents.send('host-message', { type: 'localImageResult', payload: { success: false } })
  }
}

// ---------------------------------------------------------------------------
// Native PDF Export (Task 3.6) — headless Chrome/Edge
// ---------------------------------------------------------------------------

function findBrowserExecutable(): string | undefined {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env['LocalAppData'] || path.join(os.homedir(), 'AppData\\Local')
    const candidates = [
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
    ]
    for (const p of candidates) {
      if (fsSync.existsSync(p)) return p
    }
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]
    for (const p of candidates) {
      if (fsSync.existsSync(p)) return p
    }
  } else {
    return 'chromium'
  }
  return undefined
}

function getGoogleFontsLinks(html: string): string {
  const systemFonts = new Set([
    'Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana',
    'Tahoma', 'Trebuchet MS', 'Comic Sans MS', 'Impact', 'Lucida Console',
    'Palatino Linotype', 'Segoe UI', 'Calibri', 'Cambria',
  ])
  const fontSet = new Set<string>()
  const regex = /font-family:\s*([^;"<]+)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    const fontName = match[1].trim().replace(/^["']|["']$/g, '').split(',')[0].trim()
    if (fontName && !systemFonts.has(fontName)) fontSet.add(fontName)
  }
  let links = ''
  for (const fontName of fontSet) {
    const encoded = fontName.replace(/\s+/g, '+')
    links += `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@0,100;0,300;0,400;0,500;0,700;0,900;1,100;1,300;1,400;1,500;1,700;1,900&display=swap">\n`
  }
  return links
}

function buildPrintHtml(
  bodyHtml: string,
  pageSettings: typeof DEFAULT_PAGE_SETTINGS,
  headerHtml: string,
  footerHtml: string,
  defaultFont: string,
  defaultFontSize: number,
  cssContent: string
): string {
  const googleFontsLinks = getGoogleFontsLinks(bodyHtml)
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Export PDF</title>
  ${googleFontsLinks}
  <style>${cssContent}</style>
  <style>
    @page {
      size: ${pageSettings.pageWidth}mm ${pageSettings.pageHeight}mm;
      margin: 0;
    }
    html, body {
      overflow: visible !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      background: white !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .leandix-page-surround {
      display: block !important;
      width: 100% !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      background: white !important;
    }
    .leandix-page-view {
      box-shadow: none !important;
      border: none !important;
      margin: 0 auto !important;
      display: flex !important;
      flex-direction: column !important;
      page-break-after: always !important;
      break-after: page !important;
      overflow: hidden !important;
    }
    .leandix-header-footer-separator { display: none !important; }
    .page-break {
      page-break-after: always !important;
      break-after: page !important;
      border: none !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      background: transparent !important;
    }
    .page-break::after, .page-break::before { display: none !important; }
  </style>
</head>
<body>
  <div id="raw-content" style="display:none;">${bodyHtml}</div>
  <div class="leandix-page-surround" id="pages-container"></div>
  <script>
  (function() {
    const pageWidth = ${pageSettings.pageWidth};
    const pageHeight = ${pageSettings.pageHeight};
    const marginTop = ${pageSettings.marginTop};
    const marginBottom = ${pageSettings.marginBottom};
    const marginLeft = ${pageSettings.marginLeft};
    const marginRight = ${pageSettings.marginRight};
    const defaultFont = ${JSON.stringify(defaultFont)};
    const defaultFontSize = ${defaultFontSize};
    const headerHtml = ${JSON.stringify(headerHtml)};
    const footerHtml = ${JSON.stringify(footerHtml)};
    const mmToPx = (mm) => mm * (96 / 25.4);
    const containerWidthPx = Math.round(mmToPx(pageWidth));
    const containerHeightPx = Math.round(mmToPx(pageHeight));
    const paddingTopPx = Math.round(mmToPx(marginTop));
    const paddingBottomPx = Math.round(mmToPx(marginBottom));
    const paddingLeftPx = Math.round(mmToPx(marginLeft));
    const paddingRightPx = Math.round(mmToPx(marginRight));
    const contentAreaWidthPx = containerWidthPx - paddingLeftPx - paddingRightPx;
    const headerHeight = headerHtml ? 40 : 0;
    const footerHeight = footerHtml ? 40 : 0;
    const contentAreaHeightPx = containerHeightPx - paddingTopPx - paddingBottomPx - headerHeight - footerHeight;
    const sandbox = document.createElement('div');
    sandbox.className = 'leandix-atlas-content';
    sandbox.style.position = 'absolute';
    sandbox.style.top = '-9999px';
    sandbox.style.left = '-9999px';
    sandbox.style.width = contentAreaWidthPx + 'px';
    const fontStr = defaultFont.includes(' ') && !defaultFont.startsWith("'") && !defaultFont.startsWith('"') ? "'" + defaultFont + "'" : defaultFont;
    sandbox.style.setProperty('--leandix-default-font', fontStr);
    sandbox.style.setProperty('--leandix-default-font-size', defaultFontSize + 'pt');
    const sandboxEditor = document.createElement('div');
    sandboxEditor.className = 'leandix-prosemirror tiptap';
    sandbox.appendChild(sandboxEditor);
    document.body.appendChild(sandbox);
    const rawContent = document.getElementById('raw-content');
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawContent.innerHTML;
    const BLOCK_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6']);
    tempDiv.querySelectorAll('p,h1,h2,h3,h4,h5,h6').forEach((el) => {
      if (BLOCK_TAGS.has(el.tagName) && el.childNodes.length === 0) el.appendChild(document.createElement('br'));
    });
    const nodes = Array.from(tempDiv.childNodes);
    const pages = [[]];
    let currentPageIdx = 0;
    let tempPage = document.createElement('div');
    tempPage.style.width = contentAreaWidthPx + 'px';
    tempPage.style.display = 'flow-root';
    sandboxEditor.appendChild(tempPage);
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue;
      const clonedNode = node.cloneNode(true);
      const isManualPageBreak = clonedNode.nodeType === Node.ELEMENT_NODE &&
        (clonedNode.classList.contains('page-break') || (clonedNode.tagName === 'HR' && clonedNode.classList.contains('page-break')));
      if (isManualPageBreak) {
        tempPage = document.createElement('div');
        tempPage.style.width = contentAreaWidthPx + 'px';
        tempPage.style.display = 'flow-root';
        sandboxEditor.appendChild(tempPage);
        pages.push([]);
        currentPageIdx++;
        continue;
      }
      tempPage.appendChild(clonedNode);
      if (tempPage.offsetHeight > contentAreaHeightPx) {
        tempPage.removeChild(clonedNode);
        if (clonedNode.tagName === 'TABLE') {
          const tableShell = clonedNode.cloneNode(false);
          const colgroup = clonedNode.querySelector('colgroup');
          const rows = Array.from(clonedNode.querySelectorAll('tr')).filter(r => r.closest('table') === clonedNode);
          let currentTable = tableShell.cloneNode(true);
          if (colgroup) currentTable.appendChild(colgroup.cloneNode(true));
          tempPage.appendChild(currentTable);
          for (const row of rows) {
            const rowClone = row.cloneNode(true);
            currentTable.appendChild(rowClone);
            if (tempPage.offsetHeight > contentAreaHeightPx) {
              currentTable.removeChild(rowClone);
              if (currentTable.querySelectorAll('tr').length > 0) pages[currentPageIdx].push(currentTable.outerHTML);
              tempPage = document.createElement('div');
              tempPage.style.width = contentAreaWidthPx + 'px';
              tempPage.style.display = 'flow-root';
              sandboxEditor.appendChild(tempPage);
              pages.push([]);
              currentPageIdx++;
              currentTable = tableShell.cloneNode(true);
              if (colgroup) currentTable.appendChild(colgroup.cloneNode(true));
              tempPage.appendChild(currentTable);
              currentTable.appendChild(rowClone);
            }
          }
          if (currentTable.querySelectorAll('tr').length > 0) pages[currentPageIdx].push(currentTable.outerHTML);
        } else if (clonedNode.tagName === 'UL' || clonedNode.tagName === 'OL') {
          const listShell = clonedNode.cloneNode(false);
          const items = Array.from(clonedNode.children).filter(c => c.tagName === 'LI');
          let currentList = listShell.cloneNode(true);
          tempPage.appendChild(currentList);
          let itemIndex = 1;
          for (const item of items) {
            const itemClone = item.cloneNode(true);
            currentList.appendChild(itemClone);
            if (tempPage.offsetHeight > contentAreaHeightPx) {
              currentList.removeChild(itemClone);
              if (currentList.children.length > 0) pages[currentPageIdx].push(currentList.outerHTML);
              tempPage = document.createElement('div');
              tempPage.style.width = contentAreaWidthPx + 'px';
              tempPage.style.display = 'flow-root';
              sandboxEditor.appendChild(tempPage);
              pages.push([]);
              currentPageIdx++;
              currentList = listShell.cloneNode(true);
              if (clonedNode.tagName === 'OL') currentList.setAttribute('start', String(itemIndex));
              tempPage.appendChild(currentList);
              currentList.appendChild(itemClone);
            }
            itemIndex++;
          }
          if (currentList.children.length > 0) pages[currentPageIdx].push(currentList.outerHTML);
        } else {
          tempPage = document.createElement('div');
          tempPage.style.width = contentAreaWidthPx + 'px';
          tempPage.style.display = 'flow-root';
          sandboxEditor.appendChild(tempPage);
          pages.push([]);
          currentPageIdx++;
          tempPage.appendChild(clonedNode);
          pages[currentPageIdx].push(clonedNode.outerHTML);
        }
      } else {
        pages[currentPageIdx].push(clonedNode.outerHTML);
      }
    }
    document.body.removeChild(sandbox);
    const formatHF = (markup, pageNum, totalPages) => {
      if (!markup) return '';
      return markup.replace(/\{page\}/g, String(pageNum)).replace(/\{total\}/g, String(totalPages));
    };
    const container = document.getElementById('pages-container');
    const totalPages = pages.length;
    pages.forEach((pageElements, index) => {
      const pageNum = index + 1;
      const pageDiv = document.createElement('div');
      pageDiv.className = 'leandix-page-view page-preview-sheet';
      pageDiv.style.cssText = 'width:' + pageWidth + 'mm;height:' + pageHeight + 'mm;padding-top:' + marginTop + 'mm;padding-bottom:' + marginBottom + 'mm;padding-left:' + marginLeft + 'mm;padding-right:' + marginRight + 'mm;box-sizing:border-box;position:relative;background:white;display:flex;flex-direction:column;page-break-after:always;break-after:page;overflow:hidden;';
      if (headerHtml) {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'leandix-header-section read-only';
        headerDiv.style.cssText = 'height:' + headerHeight + 'px;border-bottom:1px dashed #e2e8f0;margin-bottom:12px;font-size:9pt;color:#64748b;display:flex;align-items:center;overflow:hidden;';
        headerDiv.innerHTML = formatHF(headerHtml, pageNum, totalPages);
        pageDiv.appendChild(headerDiv);
      }
      const contentDiv = document.createElement('div');
      contentDiv.className = 'leandix-atlas-content leandix-prosemirror tiptap read-only';
      contentDiv.style.cssText = 'flex-grow:1;width:100%;overflow:visible;outline:none;';
      const pageFontStr = defaultFont.includes(' ') && !defaultFont.startsWith("'") && !defaultFont.startsWith('"') ? "'" + defaultFont + "'" : defaultFont;
      contentDiv.style.setProperty('--leandix-default-font', pageFontStr);
      contentDiv.style.setProperty('--leandix-default-font-size', defaultFontSize + 'pt');
      pageElements.forEach(html => {
        const el = document.createElement('div');
        el.innerHTML = html;
        contentDiv.appendChild(el);
      });
      pageDiv.appendChild(contentDiv);
      if (footerHtml) {
        const footerDiv = document.createElement('div');
        footerDiv.className = 'leandix-footer-section read-only';
        footerDiv.style.cssText = 'height:' + footerHeight + 'px;border-top:1px dashed #e2e8f0;margin-top:12px;font-size:9pt;color:#64748b;display:flex;align-items:center;overflow:hidden;';
        footerDiv.innerHTML = formatHF(footerHtml, pageNum, totalPages);
        pageDiv.appendChild(footerDiv);
      }
      container.appendChild(pageDiv);
    });
  })();
  </script>
</body>
</html>`
}

async function exportToPdf(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const activeTab = activeTabId ? tabs.get(activeTabId) : null
  const docState = activeTab?.documentState

  if (!docState?.fileContentHtml) {
    dialog.showErrorBox('Lỗi xuất PDF', 'Vui lòng mở hoặc tạo tài liệu trước khi xuất PDF.')
    return
  }

  const defaultName = docState.currentFilePath
    ? path.parse(docState.currentFilePath).name + '.pdf'
    : 'document.pdf'
  const defaultDir = docState.currentFilePath
    ? path.dirname(docState.currentFilePath)
    : app.getPath('documents')

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(defaultDir, defaultName),
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return

  const browserPath = findBrowserExecutable()

  // Read the compiled main.css from the webview output
  const cssPath = path.join(__dirname, '..', 'webview', 'main.css')
  let cssContent = ''
  try {
    cssContent = await fs.readFile(cssPath, 'utf-8')
  } catch {
    // proceed without CSS
  }

  const pageSettings = docState.fileExtras.pageSettings ?? DEFAULT_PAGE_SETTINGS
  const headerHtml = docState.fileExtras.headerHtml ?? ''
  const footerHtml = docState.fileExtras.footerHtml ?? ''
  const defaultFont = docState.fileExtras.defaultFont ?? 'Times New Roman'
  const defaultFontSize = docState.fileExtras.defaultFontSize ?? 12

  if (!browserPath) {
    // Fallback: use Electron printToPDF with a warning
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Không tìm thấy trình duyệt',
      message: 'Không tìm thấy Microsoft Edge hoặc Google Chrome. Sẽ xuất PDF bằng phương pháp dự phòng — header/footer và phân trang có thể không chính xác.',
      buttons: ['Tiếp tục'],
    })
    try {
      const pdfBuffer = await mainWindow.webContents.printToPDF({
        pageSize: { width: pageSettings.pageWidth * 1000, height: pageSettings.pageHeight * 1000 },
        printBackground: true,
        margins: { marginType: 'none' },
      })
      await fs.writeFile(result.filePath, pdfBuffer)
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Xuất PDF',
        message: 'Xuất PDF thành công!',
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      dialog.showErrorBox('Lỗi xuất PDF', message)
    }
    return
  }

  // Headless Chrome/Edge export
  const tempDir = path.join(os.tmpdir(), `leandix-pdf-${Date.now()}`)
  const tempHtmlPath = path.join(tempDir, 'document.html')

  try {
    fsSync.mkdirSync(tempDir, { recursive: true })

    const fullHtml = buildPrintHtml(
      docState.fileContentHtml,
      pageSettings,
      headerHtml,
      footerHtml,
      defaultFont,
      defaultFontSize,
      cssContent
    )
    fsSync.writeFileSync(tempHtmlPath, fullHtml, 'utf-8')

    const fileUrl = `file:///${tempHtmlPath.replace(/\\/g, '/')}`

    await new Promise<void>((resolve, reject) => {
      const args = [
        '--headless=old',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${result.filePath}`,
        fileUrl,
      ]
      execFile(browserPath, args, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Xuất PDF',
      message: 'Xuất PDF thành công!',
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi xuất PDF', message)
  } finally {
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Vietnamese Application Menu (Task 3.7)
// ---------------------------------------------------------------------------

const MENU_STRINGS: Record<'vi' | 'en', Record<string, string>> = {
  vi: {
    file: 'Tệp tin',
    home: 'Trang chủ',
    new: 'Tạo mới',
    open: 'Mở file...',
    save: 'Lưu',
    saveAs: 'Lưu dưới dạng...',
    exportPdf: 'Xuất PDF...',
    quit: 'Thoát',
    edit: 'Chỉnh sửa',
    undo: 'Hoàn tác',
    redo: 'Làm lại',
    cut: 'Cắt',
    copy: 'Sao chép',
    paste: 'Dán',
    selectAll: 'Chọn tất cả',
    view: 'Xem',
    reload: 'Tải lại giao diện',
    devTools: 'Bật DevTools',
    resetZoom: 'Đặt lại Zoom',
    zoomIn: 'Phóng to',
    zoomOut: 'Thu nhỏ',
    fullscreen: 'Toàn màn hình',
  },
  en: {
    file: 'File',
    home: 'Home',
    new: 'New',
    open: 'Open...',
    save: 'Save',
    saveAs: 'Save As...',
    exportPdf: 'Export PDF...',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    devTools: 'Toggle DevTools',
    resetZoom: 'Reset Zoom',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Fullscreen',
  },
}

function createAppMenu(): void {
  const m = MENU_STRINGS[currentLanguage]
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: m.file,
      submenu: [
        {
          label: m.home,
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            if (homeWindow && !homeWindow.isDestroyed()) {
              homeWindow.show()
              homeWindow.focus()
            } else {
              createHomeWindow()
            }
          },
        },
        { type: 'separator' },
        {
          label: m.new,
          accelerator: 'CmdOrCtrl+N',
          click: () => { createEditorTab() },
        },
        {
          label: m.open,
          accelerator: 'CmdOrCtrl+O',
          click: () => { void showOpenFileDialog() },
        },
        {
          label: m.save,
          accelerator: 'CmdOrCtrl+S',
          click: () => { if (activeTabId) void saveTabFile(activeTabId) },
        },
        {
          label: m.saveAs,
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => { if (activeTabId) void saveTabFileAs(activeTabId) },
        },
        { type: 'separator' },
        {
          label: m.exportPdf,
          accelerator: 'CmdOrCtrl+P',
          click: () => { void exportToPdf() },
        },
        { type: 'separator' },
        { label: m.quit, role: 'quit' },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { label: m.undo, role: 'undo' },
        { label: m.redo, role: 'redo' },
        { type: 'separator' },
        { label: m.cut, role: 'cut' },
        { label: m.copy, role: 'copy' },
        { label: m.paste, role: 'paste' },
        { label: m.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: m.view,
      submenu: [
        { label: m.reload, role: 'reload' },
        { label: m.devTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: m.resetZoom, role: 'resetZoom' },
        { label: m.zoomIn, role: 'zoomIn' },
        { label: m.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: m.fullscreen, role: 'togglefullscreen' },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------

let isQuitting = false

app.whenReady().then(() => {
  registerIpcHandlers()
  createHomeWindow()

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows exist
    if (BrowserWindow.getAllWindows().length === 0) {
      createHomeWindow()
    }
  })
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  const dirtyTabs = [...tabs.values()].filter((t) => t.isDirty)
  if (dirtyTabs.length === 0) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  event.preventDefault()
  void (async () => {
    for (const tab of dirtyTabs) {
      const action = await confirmUnsavedChangesForTab(tab)
      if (action === 'cancel') return
      if (action === 'save') await saveTabFile(tab.id)
    }
    isQuitting = true
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  createHomeWindow,
  createWindow,
  openEditorFromHome,
  openAtlasWebWindow,
  handleVsCodeMessageForTab,
  loadAndSendFileToTab,
  showOpenFileDialog,
  saveTabFile,
  saveTabFileAs,
  handleRequestLocalImage,
  exportToPdf,
  createPdfTab,
  createEditorTab,
  createAppMenu,
  addRecentFile,
  loadRecentFiles,
  tabs,
  activeTabId,
  homeWindow,
  mainWindow,
  atlasWindow,
  currentLanguage,
}
