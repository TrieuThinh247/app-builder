import React, { useEffect, useState } from 'react'
import { FileText, Globe, WifiOff, Loader, Plus, Clock, Settings, Moon, Sun, BookOpen } from 'lucide-react'
import logoUrl from '../logo/logo_final.png'

type Screen = 'checking' | 'offline' | 'online' | 'editor-home'
type Lang = 'vi' | 'en'
type Theme = 'dark' | 'light'

interface RecentFile {
  filePath: string
  title: string
  lastOpenedAt: string
}

declare global {
  interface Window {
    homeApi: {
      onNetworkStatus: (cb: (online: boolean) => void) => void
      openEditor: () => void
      openEditorNew: () => void
      openEditorWithFile: (filePath: string) => void
      openAtlasWeb: () => void
      onLanguage: (cb: (lang: string) => void) => void
      onTheme: (cb: (theme: string) => void) => void
      getSettings: () => Promise<{ language: Lang; theme: Theme }>
      applySettings: (settings: { language: Lang; theme: Theme }) => void
      openFileDialog: () => Promise<string | null>
      openPdfDialog: () => Promise<string | null>
      getRecentFiles: () => Promise<RecentFile[]>
    }
  }
}

const STRINGS = {
  vi: {
    checking: 'Đang kiểm tra kết nối...',
    offline: 'Không có kết nối mạng',
    subtitle: 'Chọn phương thức làm việc',
    editorTitle: 'Editor',
    editorDesc: 'Soạn thảo tài liệu DOCX trực tiếp',
    atlasTitle: 'Atlas Web',
    atlasDesc: 'Sử dụng AI tại atlas.leandix.com',
    offlineNote: 'Chế độ offline chỉ hỗ trợ chỉnh sửa văn bản.',
    newDoc: 'Tài liệu trống',
    openDoc: 'Mở DOCX...',
    openPdf: 'Mở PDF...',
    recentDocs: 'Tài liệu gần đây',
    noRecent: 'Chưa có tài liệu nào được mở gần đây.',
    back: '← Trang chủ',
    settings: 'Cài đặt',
    settingsTheme: 'Giao diện',
    settingsDark: 'Tối',
    settingsLight: 'Sáng',
    settingsLang: 'Ngôn ngữ',
    settingsApply: 'Áp dụng',
    settingsCancel: 'Hủy',
  },
  en: {
    checking: 'Checking connection...',
    offline: 'No network connection',
    subtitle: 'Choose your workspace',
    editorTitle: 'Editor',
    editorDesc: 'Edit DOCX documents directly',
    atlasTitle: 'Atlas Web',
    atlasDesc: 'Use AI at atlas.leandix.com',
    offlineNote: 'Offline mode supports text editing only.',
    newDoc: 'Blank document',
    openDoc: 'Open DOCX...',
    openPdf: 'Open PDF...',
    recentDocs: 'Recent documents',
    noRecent: 'No documents opened recently.',
    back: '← Home',
    settings: 'Settings',
    settingsTheme: 'Theme',
    settingsDark: 'Dark',
    settingsLight: 'Light',
    settingsLang: 'Language',
    settingsApply: 'Apply',
    settingsCancel: 'Cancel',
  },
}

function formatRelativeDate(isoString: string, lang: Lang): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (lang === 'vi') {
    if (diffDays === 0) return 'Hôm nay'
    if (diffDays === 1) return 'Hôm qua'
    if (diffDays < 7) return `${diffDays} ngày trước`
    return date.toLocaleDateString('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' })
  } else {
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
}

function DocIcon() {
  return (
    <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="36" rx="3" fill="#4285f4" opacity="0.12" />
      <rect x="3" y="3" width="22" height="30" rx="2" fill="#e8f0fe" />
      <path d="M18 3v7h7" fill="none" stroke="#4285f4" strokeWidth="1" opacity="0.5" />
      <path d="M18 3l7 7H18V3z" fill="#c5d8fd" />
      <rect x="6" y="14" width="16" height="1.5" rx="0.75" fill="#4285f4" opacity="0.4" />
      <rect x="6" y="18" width="16" height="1.5" rx="0.75" fill="#4285f4" opacity="0.4" />
      <rect x="6" y="22" width="11" height="1.5" rx="0.75" fill="#4285f4" opacity="0.4" />
    </svg>
  )
}

function PdfIcon() {
  return (
    <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="36" rx="3" fill="#ef4444" opacity="0.12" />
      <rect x="3" y="3" width="22" height="30" rx="2" fill="#fee2e2" />
      <path d="M18 3v7h7" fill="none" stroke="#ef4444" strokeWidth="1" opacity="0.5" />
      <path d="M18 3l7 7H18V3z" fill="#fecaca" />
      <text x="14" y="25" textAnchor="middle" fontSize="7" fontWeight="700" fill="#ef4444" opacity="0.8" fontFamily="sans-serif">PDF</text>
    </svg>
  )
}

interface SettingsModalProps {
  lang: Lang
  theme: Theme
  onClose: () => void
  onApply: (lang: Lang, theme: Theme) => void
}

function SettingsModal({ lang, theme, onClose, onApply }: SettingsModalProps) {
  const [draftLang, setDraftLang] = useState<Lang>(lang)
  const [draftTheme, setDraftTheme] = useState<Theme>(theme)
  const s = STRINGS[lang]

  function handleApply() {
    onApply(draftLang, draftTheme)
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      <div className="settings-modal">
        <div className="settings-modal-title">{s.settings}</div>

        <div className="settings-group">
          <div className="settings-label">{s.settingsTheme}</div>
          <div className="settings-options">
            <button
              className={`settings-option${draftTheme === 'dark' ? ' active' : ''}`}
              onClick={() => setDraftTheme('dark')}
            >
              <Moon size={13} style={{ marginRight: '0.35rem', verticalAlign: 'middle' }} />
              {s.settingsDark}
            </button>
            <button
              className={`settings-option${draftTheme === 'light' ? ' active' : ''}`}
              onClick={() => setDraftTheme('light')}
            >
              <Sun size={13} style={{ marginRight: '0.35rem', verticalAlign: 'middle' }} />
              {s.settingsLight}
            </button>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-label">{s.settingsLang}</div>
          <div className="settings-options">
            <button
              className={`settings-option${draftLang === 'vi' ? ' active' : ''}`}
              onClick={() => setDraftLang('vi')}
            >
              <span style={{ fontWeight: 700, marginRight: '0.35rem' }}>VI</span>Tiếng Việt
            </button>
            <button
              className={`settings-option${draftLang === 'en' ? ' active' : ''}`}
              onClick={() => setDraftLang('en')}
            >
              <span style={{ fontWeight: 700, marginRight: '0.35rem' }}>EN</span>English
            </button>
          </div>
        </div>

        <div className="settings-modal-actions">
          <button className="settings-btn-cancel" onClick={onClose}>{s.settingsCancel}</button>
          <button className="settings-btn-apply" onClick={handleApply}>{s.settingsApply}</button>
        </div>
      </div>
    </div>
  )
}

function EditorHomeScreen({
  lang,
  theme,
  s,
  onBack,
  onOpenSettings,
}: {
  lang: Lang
  theme: Theme
  s: typeof STRINGS['vi']
  onBack: () => void
  onOpenSettings: () => void
}) {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.homeApi.getRecentFiles().then((files) => {
      setRecentFiles(files)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  return (
    <div className="editor-home-root" data-theme={theme}>
      <div className="editor-home-header">
        <button className="editor-home-back" onClick={onBack}>{s.back}</button>
        <span className="editor-home-brand">
          <img src={logoUrl} alt="Leandix Atlas" className="editor-home-brand-logo" />
          Leandix Atlas
        </span>
        <button className="home-settings-btn editor-home-settings" onClick={onOpenSettings} title={s.settings}>
          <Settings size={15} />
        </button>
      </div>

      <div className="editor-home-body">
        {/* New document */}
        <div className="editor-home-new-row">
          <button className="editor-home-new-card" onClick={() => window.homeApi.openEditorNew()}>
            <div className="editor-home-new-icon"><Plus size={22} strokeWidth={1.5} /></div>
            <span>{s.newDoc}</span>
          </button>
          <button className="editor-home-new-card editor-home-open-card" onClick={async () => {
            const filePath = await window.homeApi.openFileDialog()
            if (filePath) window.homeApi.openEditorWithFile(filePath)
          }}>
            <div className="editor-home-new-icon"><FileText size={22} strokeWidth={1.5} /></div>
            <span>{s.openDoc}</span>
          </button>
          <button className="editor-home-new-card editor-home-open-pdf-card" onClick={async () => {
            const filePath = await window.homeApi.openPdfDialog()
            if (filePath) window.homeApi.openEditorWithFile(filePath)
          }}>
            <div className="editor-home-new-icon"><BookOpen size={22} strokeWidth={1.5} /></div>
            <span>{s.openPdf}</span>
          </button>
        </div>

        {/* Recent files */}
        <div className="editor-home-section-header">
          <span className="editor-home-section-label">{s.recentDocs}</span>
        </div>

        {loading ? (
          <div className="editor-home-empty"><Loader size={18} className="home-spin" /></div>
        ) : recentFiles.length === 0 ? (
          <div className="editor-home-empty">
            <Clock size={28} strokeWidth={1} opacity={0.3} />
            <span>{s.noRecent}</span>
          </div>
        ) : (
          <div className="editor-home-list">
            {recentFiles.map((file) => (
              <button
                key={file.filePath}
                className="editor-home-list-item"
                onClick={() => window.homeApi.openEditorWithFile(file.filePath)}
                title={file.filePath}
              >
                <div className="editor-home-list-icon">
                  {file.filePath.toLowerCase().endsWith('.pdf') ? <PdfIcon /> : <DocIcon />}
                </div>
                <div className="editor-home-list-info">
                  <span className="editor-home-list-name">{file.title}</span>
                  <span className="editor-home-list-path">{file.filePath}</span>
                </div>
                <span className="editor-home-list-date">
                  {formatRelativeDate(file.lastOpenedAt, lang)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function HomeApp() {
  const [screen, setScreen] = useState<Screen>('checking')
  const [lang, setLang] = useState<Lang>('vi')
  const [theme, setTheme] = useState<Theme>('dark')
  const [showSettings, setShowSettings] = useState(false)

  const s = STRINGS[lang]

  // Apply theme to <html> so CSS variables take effect globally
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    // Load persisted settings on mount
    window.homeApi.getSettings().then((settings) => {
      setLang(settings.language)
      setTheme(settings.theme)
    }).catch(() => {})

    window.homeApi.onNetworkStatus((online) => {
      setScreen(online ? 'online' : 'offline')
    })
    window.homeApi.onLanguage((l) => {
      if (l === 'vi' || l === 'en') setLang(l)
    })
    window.homeApi.onTheme((t) => {
      if (t === 'dark' || t === 'light') setTheme(t)
    })
  }, [])

  function handleApplySettings(newLang: Lang, newTheme: Theme) {
    setLang(newLang)
    setTheme(newTheme)
    window.homeApi.applySettings({ language: newLang, theme: newTheme })
    setShowSettings(false)
  }

  const settingsBtn = (
    <button className="home-settings-btn" onClick={() => setShowSettings(true)} title={s.settings}>
      <Settings size={15} />
    </button>
  )

  const settingsModal = showSettings ? (
    <SettingsModal
      lang={lang}
      theme={theme}
      onClose={() => setShowSettings(false)}
      onApply={handleApplySettings}
    />
  ) : null

  if (screen === 'editor-home') {
    return (
      <>
        {settingsModal}
        <EditorHomeScreen
          lang={lang}
          theme={theme}
          s={s}
          onBack={() => setScreen('online')}
          onOpenSettings={() => setShowSettings(true)}
        />
      </>
    )
  }

  if (screen === 'checking') {
    return (
      <div className="home-root">
        {settingsBtn}
        {settingsModal}
        <div className="home-logo">
          <img src={logoUrl} alt="" className="home-logo-image" />
          <span className="home-logo-text">Leandix Atlas</span>
        </div>
        <div className="home-status">
          <Loader size={18} className="home-spin" />
          <span>{s.checking}</span>
        </div>
      </div>
    )
  }

  if (screen === 'offline') {
    return (
      <div className="home-root">
        {settingsBtn}
        {settingsModal}
        <div className="home-logo">
          <img src={logoUrl} alt="" className="home-logo-image" />
          <span className="home-logo-text">Leandix Atlas</span>
        </div>
        <div className="home-status offline">
          <WifiOff size={16} />
          <span>{s.offline}</span>
        </div>
        <div className="home-actions">
          <button className="home-btn home-btn-primary" onClick={() => window.homeApi.openEditor()}>
            <FileText size={22} className="home-btn-icon" />
            <div className="home-btn-content">
              <span className="home-btn-title">{s.editorTitle}</span>
              <span className="home-btn-desc">{s.editorDesc}</span>
            </div>
          </button>
        </div>
        <p className="home-note">{s.offlineNote}</p>
      </div>
    )
  }

  return (
    <div className="home-root">
      {settingsBtn}
      {settingsModal}
      <div className="home-logo">
        <img src={logoUrl} alt="" className="home-logo-image" />
        <span className="home-logo-text">Leandix Atlas</span>
      </div>
      <p className="home-subtitle">{s.subtitle}</p>
      <div className="home-actions">
        <button className="home-btn home-btn-primary" onClick={() => setScreen('editor-home')}>
          <FileText size={22} className="home-btn-icon" />
          <div className="home-btn-content">
            <span className="home-btn-title">{s.editorTitle}</span>
            <span className="home-btn-desc">{s.editorDesc}</span>
          </div>
        </button>
        <button className="home-btn home-btn-secondary" onClick={() => window.homeApi.openAtlasWeb()}>
          <Globe size={22} className="home-btn-icon" />
          <div className="home-btn-content">
            <span className="home-btn-title">{s.atlasTitle}</span>
            <span className="home-btn-desc">{s.atlasDesc}</span>
          </div>
        </button>
      </div>
    </div>
  )
}
