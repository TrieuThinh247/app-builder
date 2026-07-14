/// <reference path="../../electron/tab-bar-preload.ts" />

;(function () {
  const tabsEl = document.getElementById('tabs')
  const openModeOverlay = document.getElementById('open-mode-overlay')
  const btnNewTab = document.getElementById('btn-new-tab')
  const btnReplaceTab = document.getElementById('btn-replace-tab')
  const btnCancelOpen = document.getElementById('btn-cancel-open')
  const openModeLabel = document.getElementById('open-mode-label')
  const newTabBtn = document.getElementById('new-tab-btn')

  const STRINGS = {
    vi: {
      newTab: 'Tab mới',
      openIn: 'Mở file trong:',
      btnNewTab: 'Tab mới',
      btnReplace: 'Thay thế tab hiện tại',
      btnCancel: 'Hủy',
      closeTab: 'Đóng tab',
      unsaved: 'Chưa lưu',
    },
    en: {
      newTab: 'New tab',
      openIn: 'Open file in:',
      btnNewTab: 'New tab',
      btnReplace: 'Replace current tab',
      btnCancel: 'Cancel',
      closeTab: 'Close tab',
      unsaved: 'Unsaved',
    },
  }

  let lang = 'vi'
  let lastTabs = []

  function s(key) {
    return (STRINGS[lang] || STRINGS.vi)[key]
  }

  function applyLanguage() {
    newTabBtn.title = s('newTab')
    openModeLabel.textContent = s('openIn')
    btnNewTab.textContent = s('btnNewTab')
    btnReplaceTab.textContent = s('btnReplace')
    btnCancelOpen.textContent = s('btnCancel')
    renderTabs(lastTabs)
  }

  newTabBtn.addEventListener('click', () => {
    window.tabBarApi.createTab()
  })

  btnNewTab.addEventListener('click', () => {
    openModeOverlay.classList.remove('visible')
    window.tabBarApi.respondOpenMode('new')
  })

  btnReplaceTab.addEventListener('click', () => {
    openModeOverlay.classList.remove('visible')
    window.tabBarApi.respondOpenMode('replace')
  })

  btnCancelOpen.addEventListener('click', () => {
    openModeOverlay.classList.remove('visible')
  })

  window.tabBarApi.onTabState((tabs) => {
    lastTabs = tabs
    renderTabs(tabs)
  })

  window.tabBarApi.onAskOpenMode(() => {
    openModeOverlay.classList.add('visible')
  })

  window.tabBarApi.onLanguage((newLang) => {
    lang = newLang
    applyLanguage()
  })

  window.tabBarApi.onTheme((newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme)
  })

  function renderTabs(tabs) {
    tabsEl.innerHTML = ''
    for (const tab of tabs) {
      const el = document.createElement('div')
      el.className = 'tab' + (tab.isActive ? ' active' : '')
      el.dataset.tabId = tab.id

      const icon = document.createElement('span')
      icon.className = 'tab-icon'
      icon.textContent = tab.type === 'pdf' ? '📄' : '📝'

      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = tab.title
      title.title = tab.title

      const closeBtn = document.createElement('span')
      closeBtn.className = 'tab-close'
      closeBtn.textContent = '×'
      closeBtn.title = s('closeTab')

      if (tab.isDirty) {
        const dirty = document.createElement('span')
        dirty.className = 'tab-dirty'
        dirty.textContent = '●'
        dirty.title = s('unsaved')
        el.appendChild(icon)
        el.appendChild(title)
        el.appendChild(dirty)
        el.appendChild(closeBtn)
      } else {
        el.appendChild(icon)
        el.appendChild(title)
        el.appendChild(closeBtn)
      }

      el.addEventListener('click', (e) => {
        if (e.target === closeBtn) return
        window.tabBarApi.switchTab(tab.id)
      })

      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        window.tabBarApi.closeTab(tab.id)
      })

      tabsEl.appendChild(el)
    }

    const activeEl = tabsEl.querySelector('.tab.active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  applyLanguage()
  window.tabBarApi.ready()
})()
