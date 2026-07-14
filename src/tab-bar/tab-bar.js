/// <reference path="../../electron/tab-bar-preload.ts" />

;(function () {
  const tabsEl = document.getElementById('tabs')
  const openModeOverlay = document.getElementById('open-mode-overlay')
  const btnNewTab = document.getElementById('btn-new-tab')
  const btnReplaceTab = document.getElementById('btn-replace-tab')
  const btnCancelOpen = document.getElementById('btn-cancel-open')

  document.getElementById('new-tab-btn').addEventListener('click', () => {
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
    renderTabs(tabs)
  })

  window.tabBarApi.onAskOpenMode(() => {
    openModeOverlay.classList.add('visible')
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
      closeBtn.title = 'Đóng tab'

      if (tab.isDirty) {
        const dirty = document.createElement('span')
        dirty.className = 'tab-dirty'
        dirty.textContent = '●'
        dirty.title = 'Chưa lưu'
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

    // Scroll active tab into view
    const activeEl = tabsEl.querySelector('.tab.active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  window.tabBarApi.ready()
})()
