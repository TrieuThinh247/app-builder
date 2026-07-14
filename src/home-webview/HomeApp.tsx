import React, { useEffect, useState } from 'react'
import { FileText, Globe, WifiOff, Loader } from 'lucide-react'

type Screen = 'checking' | 'offline' | 'online'

declare global {
  interface Window {
    homeApi: {
      onNetworkStatus: (cb: (online: boolean) => void) => void
      openEditor: () => void
      openAtlasWeb: () => void
    }
  }
}

export default function HomeApp() {
  const [screen, setScreen] = useState<Screen>('checking')

  useEffect(() => {
    window.homeApi.onNetworkStatus((online) => {
      setScreen(online ? 'online' : 'offline')
    })
  }, [])

  if (screen === 'checking') {
    return (
      <div className="home-root">
        <div className="home-logo">
          <span className="home-logo-text">Leandix Atlas</span>
        </div>
        <div className="home-status">
          <Loader size={18} className="home-spin" />
          <span>Đang kiểm tra kết nối...</span>
        </div>
      </div>
    )
  }

  if (screen === 'offline') {
    return (
      <div className="home-root">
        <div className="home-logo">
          <span className="home-logo-text">Leandix Atlas</span>
        </div>
        <div className="home-status offline">
          <WifiOff size={16} />
          <span>Không có kết nối mạng</span>
        </div>
        <div className="home-actions">
          <button className="home-btn home-btn-primary" onClick={() => window.homeApi.openEditor()}>
            <FileText size={22} className="home-btn-icon" />
            <div className="home-btn-content">
              <span className="home-btn-title">Editor</span>
              <span className="home-btn-desc">Soạn thảo tài liệu DOCX trực tiếp</span>
            </div>
          </button>
        </div>
        <p className="home-note">Chế độ offline chỉ hỗ trợ chỉnh sửa văn bản.</p>
      </div>
    )
  }

  return (
    <div className="home-root">
      <div className="home-logo">
        <span className="home-logo-text">Leandix Atlas</span>
      </div>
      <p className="home-subtitle">Chọn phương thức làm việc</p>
      <div className="home-actions">
        <button className="home-btn home-btn-primary" onClick={() => window.homeApi.openEditor()}>
          <FileText size={22} className="home-btn-icon" />
          <div className="home-btn-content">
            <span className="home-btn-title">Editor</span>
            <span className="home-btn-desc">Soạn thảo tài liệu DOCX trực tiếp</span>
          </div>
        </button>
        <button className="home-btn home-btn-secondary" onClick={() => window.homeApi.openAtlasWeb()}>
          <Globe size={22} className="home-btn-icon" />
          <div className="home-btn-content">
            <span className="home-btn-title">Atlas Web</span>
            <span className="home-btn-desc">Sử dụng AI tại atlas.leandix.com</span>
          </div>
        </button>
      </div>
    </div>
  )
}
