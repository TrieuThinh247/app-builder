import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
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
// In-memory Document State
// ---------------------------------------------------------------------------

interface DocumentState {
  /** Absolute path of the currently open file, or null for an unsaved new document. */
  currentFilePath: string | null
  /** Latest body HTML received from the renderer. */
  fileContentHtml: string
  /** Latest header/footer/comments/page-settings received from the renderer. */
  fileExtras: {
    headerHtml?: string
    footerHtml?: string
    comments?: Array<{
      id: string
      author: string
      date: string
      text: string
      rangeStart: number
      rangeEnd: number
      replies?: Array<{ id: string; author: string; date: string; text: string }>
    }>
    pageSettings?: typeof DEFAULT_PAGE_SETTINGS
    defaultFont?: string
    defaultFontSize?: number
  }
}

let homeWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let atlasWindow: BrowserWindow | null = null

/** Track PDF viewer windows so we can manage them */
let pdfWindows: BrowserWindow[] = []
/** Map PDF window IDs to their file paths */
const pdfWindowFilePaths = new Map<number, string>()

let documentState: DocumentState = {
  currentFilePath: null,
  fileContentHtml: '',
  fileExtras: {},
}

/** Current UI language — toggled between 'vi' and 'en' */
let currentLanguage: 'vi' | 'en' = 'vi'

/** Track whether the document has unsaved changes */
let isDocumentDirty = false

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
    width: 600,
    height: 480,
    resizable: false,
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

function openEditorFromHome(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    homeWindow?.close()
    return
  }
  createWindow()
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

  atlasWindow.on('closed', () => {
    atlasWindow = null
  })

  homeWindow?.close()
}

async function confirmUnsavedChanges(): Promise<'save' | 'discard' | 'cancel'> {
  if (!mainWindow || mainWindow.isDestroyed()) return 'discard'
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Tài liệu chưa lưu',
    message: 'Tài liệu có thay đổi chưa lưu. Bạn có muốn lưu trước khi thoát không?',
    buttons: ['Lưu', 'Không lưu', 'Hủy'],
    defaultId: 0,
    cancelId: 2,
  })
  if (response === 0) return 'save'
  if (response === 1) return 'discard'
  return 'cancel'
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'webview', 'index.html'))
  createAppMenu()

  mainWindow.on('close', (event) => {
    if (!isDocumentDirty) return
    event.preventDefault()
    void confirmUnsavedChanges().then(async (action) => {
      if (action === 'cancel') return
      if (action === 'save') await saveCurrentFile()
      isDocumentDirty = false
      mainWindow?.destroy()
    })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// IPC Message Dispatch (Task 3.2) — registered in app.whenReady()
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.on('home-action', (_event, message: { type: string }) => {
    if (message.type === 'open-editor') {
      openEditorFromHome()
    } else if (message.type === 'open-atlas-web') {
      openAtlasWebWindow()
    }
  })

  ipcMain.on('vscode-message', (event, message) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
      void handleVsCodeMessage(message)
      return
    }

    const pdfWin = pdfWindows.find((w) => !w.isDestroyed() && w.webContents === event.sender)
    if (pdfWin) {
      void handlePdfWindowMessage(pdfWin, message)
    }
  })
}

async function handleVsCodeMessage(message: unknown): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!message || typeof message !== 'object') return
  const msg = message as { type?: unknown; payload?: unknown }
  if (typeof msg.type !== 'string') return

  switch (msg.type) {
    case 'ready': {
      if (documentState.currentFilePath) {
        await loadAndSendFile(documentState.currentFilePath)
      } else {
        mainWindow.webContents.send('host-message', {
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
      // Validate required fields before updating state
      if (
        typeof payload.html !== 'string' ||
        typeof payload.headerHtml !== 'string' ||
        typeof payload.footerHtml !== 'string' ||
        !Array.isArray(payload.comments) ||
        !payload.pageSettings ||
        typeof payload.pageSettings !== 'object'
      ) {
        return
      }
      documentState.fileContentHtml = payload.html as string
      documentState.fileExtras = {
        headerHtml: payload.headerHtml as string,
        footerHtml: payload.footerHtml as string,
        comments: payload.comments as DocumentState['fileExtras']['comments'],
        pageSettings: payload.pageSettings as typeof DEFAULT_PAGE_SETTINGS,
        defaultFont: typeof payload.defaultFont === 'string' ? payload.defaultFont : documentState.fileExtras.defaultFont,
        defaultFontSize: typeof payload.defaultFontSize === 'number' ? payload.defaultFontSize : documentState.fileExtras.defaultFontSize,
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
      ) {
        return
      }
      documentState.fileContentHtml = payload.html as string
      documentState.fileExtras = {
        headerHtml: payload.headerHtml as string,
        footerHtml: payload.footerHtml as string,
        comments: payload.comments as DocumentState['fileExtras']['comments'],
        pageSettings: payload.pageSettings as typeof DEFAULT_PAGE_SETTINGS,
        defaultFont: typeof payload.defaultFont === 'string' ? payload.defaultFont : documentState.fileExtras.defaultFont,
        defaultFontSize: typeof payload.defaultFontSize === 'number' ? payload.defaultFontSize : documentState.fileExtras.defaultFontSize,
      }
      await saveCurrentFile()
      break
    }

    case 'requestLocalImage': {
      await handleRequestLocalImage()
      break
    }

    case 'dirtyStateChanged': {
      const payload = msg.payload as Record<string, unknown> | undefined
      if (payload && typeof payload.isDirty === 'boolean') {
        isDocumentDirty = payload.isDirty
      }
      break
    }

    case 'toggleLanguage': {
      currentLanguage = currentLanguage === 'vi' ? 'en' : 'vi'
      mainWindow.webContents.send('host-message', {
        type: 'language',
        payload: { language: currentLanguage },
      })
      // Broadcast to all open PDF windows
      for (const pdfWin of pdfWindows) {
        if (!pdfWin.isDestroyed()) {
          pdfWin.webContents.send('host-message', {
            type: 'language',
            payload: { language: currentLanguage },
          })
        }
      }
      break
    }

    default:
      // Unknown message types are silently ignored
      break
  }
}

// ---------------------------------------------------------------------------
// Document Loading (Task 3.3)
// ---------------------------------------------------------------------------

async function loadAndSendFile(filePath: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  try {
    const buffer = await fs.readFile(filePath)
    const parsed = await parseDocx(buffer as unknown as Buffer)

    // Update Document_State
    documentState.currentFilePath = filePath
    documentState.fileContentHtml = parsed.bodyHtml
    documentState.fileExtras = {
      headerHtml: parsed.headerHtml,
      footerHtml: parsed.footerHtml,
      comments: parsed.comments,
      pageSettings: parsed.pageSettings || DEFAULT_PAGE_SETTINGS,
      defaultFont: parsed.metadata?.defaultFont ?? undefined,
      defaultFontSize: parsed.metadata?.defaultFontSize ?? undefined,
    }

    // Build the load message payload
    const payload = {
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
    }

    mainWindow.webContents.send('host-message', { type: 'load', payload })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi mở file', message)
  }
}

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
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    openPdfViewer(filePath)
  } else {
    await loadAndSendFile(filePath)
  }
}

function openPdfViewer(filePath: string): void {
  const pdfWindow = new BrowserWindow({
    width: 1024,
    height: 800,
    title: `PDF - ${path.basename(filePath)}`,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  })

  const pdfjsRoot = path.join(__dirname, '..', 'pdfjs')
  const viewerHtmlPath = path.join(pdfjsRoot, 'web', 'viewer.html')
  const buildBase = path.join(pdfjsRoot, 'build').replace(/\\/g, '/')
  const pdfFileUrl = `file:///${filePath.replace(/\\/g, '/')}`
  const workerSrc = `file:///${buildBase}/pdf.worker.mjs`
  const sandboxSrc = `file:///${buildBase}/pdf.sandbox.mjs`

  pdfWindow.loadFile(viewerHtmlPath)

  pdfWindow.webContents.once('did-finish-load', () => {
    pdfWindow.webContents.executeJavaScript(`
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

  pdfWindows.push(pdfWindow)
  pdfWindowFilePaths.set(pdfWindow.id, filePath)

  pdfWindow.on('closed', () => {
    pdfWindows = pdfWindows.filter((w) => w !== pdfWindow)
    pdfWindowFilePaths.delete(pdfWindow.id)
  })
}

async function handlePdfWindowMessage(pdfWindow: BrowserWindow, message: unknown): Promise<void> {
  if (pdfWindow.isDestroyed()) return
  if (!message || typeof message !== 'object') return
  const msg = message as { type?: string }

  switch (msg.type) {
    case 'ready': {
      const filePath = pdfWindowFilePaths.get(pdfWindow.id)
      if (filePath) {
        // Convert local file path to a file:// URL for pdfjs-dist to load
        const fileUrl = `file://${filePath.replace(/\\/g, '/')}`
        pdfWindow.webContents.send('host-message', {
          type: 'load-pdf-url',
          payload: { url: fileUrl },
        })
      }
      // Also send language info
      pdfWindow.webContents.send('host-message', {
        type: 'language',
        payload: { language: currentLanguage },
      })
      break
    }

    case 'request-password': {
      await handlePdfPasswordRequest(pdfWindow)
      break
    }

    default:
      break
  }
}

async function handlePdfPasswordRequest(pdfWindow: BrowserWindow): Promise<void> {
  if (pdfWindow.isDestroyed()) return

  await dialog.showMessageBox(pdfWindow, {
    type: 'warning',
    title: 'PDF được bảo vệ',
    message: 'File PDF này yêu cầu mật khẩu. Tính năng nhập mật khẩu chưa được hỗ trợ trong bản desktop.',
    buttons: ['Đóng'],
  })

  // Close the PDF window instead of sending password: null, which would
  // cause PdfViewerApp to render a confusing error screen.
  if (!pdfWindow.isDestroyed()) {
    pdfWindow.close()
  }
}

async function showOpenPdfDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile'],
  })

  if (result.canceled || result.filePaths.length === 0) return

  openPdfViewer(result.filePaths[0])
}

// ---------------------------------------------------------------------------
// Document Saving (Task 3.4)
// ---------------------------------------------------------------------------

async function saveCurrentFile(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  // If no file path exists, route through Save As dialog first
  if (documentState.currentFilePath === null) {
    await showSaveAsDialog()
    return
  }

  try {
    const buffer = await serializeToDocx(documentState.fileContentHtml, {
      headerHtml: documentState.fileExtras.headerHtml,
      footerHtml: documentState.fileExtras.footerHtml,
      comments: documentState.fileExtras.comments,
      pageSettings: documentState.fileExtras.pageSettings,
      defaultFont: documentState.fileExtras.defaultFont,
      defaultFontSize: documentState.fileExtras.defaultFontSize,
    })

    await fs.writeFile(documentState.currentFilePath, buffer)

    isDocumentDirty = false
    mainWindow.webContents.send('host-message', { type: 'saved', payload: {} })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi lưu file', message)
  }
}

async function showSaveAsDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Word Documents', extensions: ['docx'] }],
  })

  // If user cancels, abort without writing, without modifying currentFilePath, without sending saved
  if (result.canceled || !result.filePath) return

  try {
    const buffer = await serializeToDocx(documentState.fileContentHtml, {
      headerHtml: documentState.fileExtras.headerHtml,
      footerHtml: documentState.fileExtras.footerHtml,
      comments: documentState.fileExtras.comments,
      pageSettings: documentState.fileExtras.pageSettings,
      defaultFont: documentState.fileExtras.defaultFont,
      defaultFontSize: documentState.fileExtras.defaultFontSize,
    })

    await fs.writeFile(result.filePath, buffer)

    // Only update currentFilePath after successful write
    documentState.currentFilePath = result.filePath

    isDocumentDirty = false
    mainWindow.webContents.send('host-message', { type: 'saved', payload: {} })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Lỗi lưu file', message)
  }
}

// ---------------------------------------------------------------------------
// Local Image Insertion (Task 3.5)
// ---------------------------------------------------------------------------

async function handleRequestLocalImage(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
    ],
    properties: ['openFile'],
  })

  // On cancel: take no action
  if (result.canceled || result.filePaths.length === 0) return

  const filePath = result.filePaths[0]

  try {
    const buffer = await fs.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    const base64Data = `data:${mime};base64,${buffer.toString('base64')}`
    const fileName = path.basename(filePath)

    mainWindow.webContents.send('host-message', {
      type: 'localImageResult',
      payload: {
        success: true,
        base64Data,
        fileName,
      },
    })
  } catch {
    // On read failure: send localImageResult with success: false
    mainWindow.webContents.send('host-message', {
      type: 'localImageResult',
      payload: {
        success: false,
      },
    })
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

  if (documentState.currentFilePath === null && !documentState.fileContentHtml) {
    dialog.showErrorBox('Lỗi xuất PDF', 'Vui lòng mở hoặc tạo tài liệu trước khi xuất PDF.')
    return
  }

  const defaultName = documentState.currentFilePath
    ? path.parse(documentState.currentFilePath).name + '.pdf'
    : 'document.pdf'
  const defaultDir = documentState.currentFilePath
    ? path.dirname(documentState.currentFilePath)
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

  const pageSettings = documentState.fileExtras.pageSettings ?? DEFAULT_PAGE_SETTINGS
  const headerHtml = documentState.fileExtras.headerHtml ?? ''
  const footerHtml = documentState.fileExtras.footerHtml ?? ''
  const defaultFont = documentState.fileExtras.defaultFont ?? 'Times New Roman'
  const defaultFontSize = documentState.fileExtras.defaultFontSize ?? 12

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
      documentState.fileContentHtml,
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

function createAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Tệp tin',
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
        { type: 'separator' },
        {
          label: 'Tạo mới',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            void (async () => {
              if (isDocumentDirty && mainWindow && !mainWindow.isDestroyed()) {
                const { response } = await dialog.showMessageBox(mainWindow, {
                  type: 'question',
                  title: 'Tài liệu chưa lưu',
                  message: 'Tài liệu có thay đổi chưa lưu. Bạn có muốn lưu không?',
                  buttons: ['Lưu', 'Không lưu', 'Hủy'],
                  defaultId: 0,
                  cancelId: 2,
                })
                if (response === 2) return // Cancel
                if (response === 0) await saveCurrentFile()
              }
              documentState.currentFilePath = null
              documentState.fileContentHtml = ''
              documentState.fileExtras = {}
              isDocumentDirty = false
              mainWindow?.reload()
            })()
          },
        },
        {
          label: 'Mở file...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void showOpenFileDialog()
          },
        },
        {
          label: 'Mở file PDF...',
          click: () => {
            void showOpenPdfDialog()
          },
        },
        {
          label: 'Lưu',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            void saveCurrentFile()
          },
        },
        {
          label: 'Lưu dưới dạng...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            void showSaveAsDialog()
          },
        },
        { type: 'separator' },
        {
          label: 'Xuất PDF...',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            void exportToPdf()
          },
        },
        { type: 'separator' },
        {
          label: 'Thoát',
          role: 'quit',
        },
      ],
    },
    {
      label: 'Chỉnh sửa',
      submenu: [
        { label: 'Hoàn tác', role: 'undo' },
        { label: 'Làm lại', role: 'redo' },
        { type: 'separator' },
        { label: 'Cắt', role: 'cut' },
        { label: 'Sao chép', role: 'copy' },
        { label: 'Dán', role: 'paste' },
        { label: 'Chọn tất cả', role: 'selectAll' },
      ],
    },
    {
      label: 'Xem',
      submenu: [
        { label: 'Tải lại giao diện', role: 'reload' },
        { label: 'Bật DevTools', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Đặt lại Zoom', role: 'resetZoom' },
        { label: 'Phóng to', role: 'zoomIn' },
        { label: 'Thu nhỏ', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toàn màn hình', role: 'togglefullscreen' },
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
  if (!isDocumentDirty || isQuitting) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  event.preventDefault()
  void confirmUnsavedChanges().then(async (action) => {
    if (action === 'cancel') return
    if (action === 'save') await saveCurrentFile()
    isQuitting = true
    app.quit()
  })
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
  handleVsCodeMessage,
  loadAndSendFile,
  showOpenFileDialog,
  saveCurrentFile,
  showSaveAsDialog,
  handleRequestLocalImage,
  exportToPdf,
  openPdfViewer,
  showOpenPdfDialog,
  handlePdfWindowMessage,
  createAppMenu,
  documentState,
  homeWindow,
  mainWindow,
  atlasWindow,
  pdfWindows,
  currentLanguage,
  isDocumentDirty,
}
