import React, { useEffect, useState } from 'react'
import { FileText, Globe, WifiOff, Loader, Plus, Clock, MoreVertical } from 'lucide-react'

type Screen = 'checking' | 'offline' | 'online' | 'editor-home'
type Lang = 'vi' | 'en'

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
      toggleLanguage: () => void
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
    toggleLang: 'EN',
    newDoc: 'Tài liệu trống',
    recentDocs: 'Tài liệu gần đây',
    noRecent: 'Chưa có tài liệu nào được mở gần đây.',
    openFile: 'Đã mở',
    back: '← Trang chủ',
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
    toggleLang: 'VI',
    newDoc: 'Blank document',
    recentDocs: 'Recent documents',
    noRecent: 'No documents opened recently.',
    openFile: 'Opened',
    back: '← Home',
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

function EditorHomeScreen({ lang, s, onBack }: { lang: Lang; s: typeof STRINGS['vi']; onBack: () => void }) {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.homeApi.getRecentFiles().then((files) => {
      setRecentFiles(files)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  return (
    <div className="editor-home-root">
      <div className="editor-home-header">
        <button className="editor-home-back" onClick={onBack}>{s.back}</button>
      </div>

      <div className="editor-home-body">
        {/* New document row */}
        <div className="editor-home-section-label">{lang === 'vi' ? 'Bắt đầu tài liệu mới' : 'Start a new document'}</div>
        <div className="editor-home-new-row">
          <button className="editor-home-new-card" onClick={() => window.homeApi.openEditorNew()}>
            <div className="editor-home-new-icon"><Plus size={32} strokeWidth={1.5} /></div>
            <span>{s.newDoc}</span>
          </button>
        </div>

        {/* Recent files */}
        <div className="editor-home-section-label editor-home-recent-label">
          {s.recentDocs}
        </div>

        {loading ? (
          <div className="editor-home-empty"><Loader size={18} className="home-spin" /></div>
        ) : recentFiles.length === 0 ? (
          <div className="editor-home-empty">
            <Clock size={32} strokeWidth={1} opacity={0.3} />
            <span>{s.noRecent}</span>
          </div>
        ) : (
          <div className="editor-home-grid">
            {recentFiles.map((file) => (
              <button
                key={file.filePath}
                className="editor-home-file-card"
                onClick={() => window.homeApi.openEditorWithFile(file.filePath)}
                title={file.filePath}
              >
                <div className="editor-home-file-thumb">
                  <DocIcon />
                </div>
                <div className="editor-home-file-info">
                  <span className="editor-home-file-name">{file.title}</span>
                  <span className="editor-home-file-date">
                    {formatRelativeDate(file.lastOpenedAt, lang)}
                  </span>
                </div>
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

  const s = STRINGS[lang]

  useEffect(() => {
    window.homeApi.onNetworkStatus((online) => {
      setScreen(online ? 'online' : 'offline')
    })
    window.homeApi.onLanguage((l) => {
      if (l === 'vi' || l === 'en') setLang(l)
    })
  }, [])

  const langToggle = (
    <button className="home-lang-toggle" onClick={() => window.homeApi.toggleLanguage()} title="Toggle language">
      {s.toggleLang}
    </button>
  )

  if (screen === 'editor-home') {
    return (
      <>
        {langToggle}
        <EditorHomeScreen lang={lang} s={s} onBack={() => setScreen('online')} />
      </>
    )
  }

  if (screen === 'checking') {
    return (
      <div className="home-root">
        {langToggle}
        <div className="home-logo">
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
        {langToggle}
        <div className="home-logo">
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
      {langToggle}
      <div className="home-logo">
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
