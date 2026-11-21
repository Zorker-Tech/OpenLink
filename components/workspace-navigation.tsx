'use client'

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { BotRailAvatar } from '@/components/bot/bot-rail-avatar'
import { useT } from '@/lib/i18n/client'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const iconPath = '/openlink/navigation/'
const SIDEBAR_MIN_WIDTH = 240
const DEFAULT_SIDEBAR_SIZING = { defaultWidth: 288, maxWidth: 420, storageKey: 'openlink-chat-sidebar-width' }
type SidebarSizing = typeof DEFAULT_SIDEBAR_SIZING

/** Shared outer app rail used by workspace and settings page shells. */
export function WorkspaceNavigationRail({ activePage, botSidebar, botUnreadCount = 0, activeBotSessionId, footer, onCloseMobile, onHistory, onLeave, onPeek, sidebarWidth, workspaceSlug }: {
  activePage?: string
  botSidebar?: { expanded: boolean; toggle: () => void; ref: Ref<HTMLButtonElement> }
  botUnreadCount?: number
  activeBotSessionId?: string
  footer: ReactNode
  onCloseMobile: () => void
  onHistory: () => void
  onLeave?: () => void
  onPeek?: () => void
  sidebarWidth: number
  workspaceSlug: string
}) {
  const t = useT()
  const railClass = 'workspace-rail-button'
  const botLabel = botUnreadCount > 0 ? `${t('Bot')} · ${botUnreadCount}` : t('Bot')
  const botIcon = <><BotRailAvatar key={workspaceSlug} activeSessionId={activeBotSessionId} workspaceSlug={workspaceSlug} />{botUnreadCount > 0 ? <span aria-hidden="true" className="absolute right-0.5 top-0.5 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ff453a] px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-[var(--app-background)]">{botUnreadCount > 9 ? '9+' : botUnreadCount}</span> : null}</>
  return (
    <nav aria-label={t('工作区导航')} className="workspace-navigation-rail" style={{ '--workspace-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <div className="flex flex-1 flex-col items-center gap-4">
        <Link aria-current={!activePage || activePage === t('首页') ? 'page' : undefined} aria-label={t('首页')} className={railClass} href={`/app/${workspaceSlug}`} onMouseEnter={onPeek} onMouseLeave={onLeave} onClick={onCloseMobile} title={t('首页')}><img alt="" className="app-nav-icon" src={`${iconPath}home.svg`} /></Link>
        {botSidebar ? (
          <button aria-controls="workspace-chat-sidebar" aria-current="page" aria-expanded={botSidebar.expanded} aria-label={botLabel} className={`${railClass} relative`} onClick={botSidebar.toggle} ref={botSidebar.ref} title={t('Bot')} type="button">{botIcon}</button>
        ) : (
          <Link aria-current={activePage === t('Bot') ? 'page' : undefined} aria-label={botLabel} className={`${railClass} relative`} href={`/app/${workspaceSlug}/bots`} onClick={onCloseMobile} title={t('Bot')}>{botIcon}</Link>
        )}
        <button aria-label={t('库')} aria-disabled="true" className={railClass} title={t('库（即将推出）')} type="button"><img alt="" className="app-nav-icon" src={`${iconPath}library.svg`} /></button>
        <Link aria-current={activePage === t('项目') ? 'page' : undefined} aria-label={t('项目')} className={railClass} href={`/app/${workspaceSlug}/projects`} onClick={onCloseMobile} title={t('项目')}><img alt="" className="app-nav-icon" src={`${iconPath}projects.svg`} /></Link>
        <button aria-label={t('搜索聊天')} className={railClass} onClick={onHistory} title={t('搜索聊天')} type="button"><img alt="" className="app-nav-icon" src={`${iconPath}history.svg`} /></button>
        <Link aria-current={activePage === t('知识库') ? 'page' : undefined} aria-label={t('知识库')} className={railClass} href={`/app/${workspaceSlug}/knowledge`} onClick={onCloseMobile} title={t('知识库')}><img alt="" className="app-nav-icon" src={`${iconPath}knowledge.svg`} /></Link>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-current={activePage === t('更多') ? 'page' : undefined} aria-label={t('更多')} className={railClass} title={t('更多')} type="button" />}><img alt="" className="app-nav-icon" src={`${iconPath}more.svg`} /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" sideOffset={8}>
            <DropdownMenuItem render={<Link href="/settings" />}>{t('个人设置')}</DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/settings/ai-providers" />}>{t('AI 服务商')}</DropdownMenuItem>
            <DropdownMenuItem disabled>{t('模板（即将推出）')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {footer}
    </nav>
  )
}

/** The app rail stays mounted while the conversation sidebar is pinned or previewed. */
export function WorkspaceNavigation({ activePage, botUnreadCount, activeBotSessionId, children, collapsed, footer, mobileOpen, onCloseMobile, onHistory, onToggle, sidebarSizing = DEFAULT_SIDEBAR_SIZING, toggleSidebarFromBot, workspaceSlug }: {
  activePage?: string
  botUnreadCount?: number
  activeBotSessionId?: string
  children: ReactNode
  collapsed: boolean
  footer: ReactNode
  mobileOpen: boolean
  onCloseMobile: () => void
  onHistory: () => void
  onToggle: () => void
  sidebarSizing?: SidebarSizing
  toggleSidebarFromBot?: boolean
  workspaceSlug: string
}) {
  const t = useT()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [desktop, setDesktop] = useState(false)
  const { defaultWidth, maxWidth, storageKey } = sidebarSizing
  const [sidebarWidth, setSidebarWidth] = useState(defaultWidth)
  const [isResizing, setIsResizing] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sidebarWidthRef = useRef(defaultWidth)
  const dragStart = useRef({ pointerX: 0, width: defaultWidth })
  const visible = desktop ? !collapsed || previewOpen : mobileOpen
  const updateSidebarWidth = (width: number, persist = false) => {
    const nextWidth = Math.min(maxWidth, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
    sidebarWidthRef.current = nextWidth
    setSidebarWidth(nextWidth)
    if (persist) window.localStorage.setItem(storageKey, String(nextWidth))
  }
  const clearLeave = () => { if (leaveTimer.current) clearTimeout(leaveTimer.current) }
  const peek = () => { clearLeave(); if (collapsed) setPreviewOpen(true) }
  const leave = () => {
    clearLeave()
    leaveTimer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) setPreviewOpen(false)
    }, 220)
  }

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)')
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update); clearLeave() }
  }, [])

  useEffect(() => {
    try {
      const savedWidth = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10)
      updateSidebarWidth(Number.isFinite(savedWidth) ? savedWidth : defaultWidth)
    } catch { updateSidebarWidth(defaultWidth) }
  }, [defaultWidth, maxWidth, storageKey])

  useEffect(() => {
    if (!isResizing) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const handlePointerMove = (event: PointerEvent) => updateSidebarWidth(dragStart.current.width + event.clientX - dragStart.current.pointerX)
    const handlePointerUp = () => {
      window.localStorage.setItem(storageKey, String(sidebarWidthRef.current))
      setIsResizing(false)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
    window.addEventListener('pointercancel', handlePointerUp, { once: true })
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [isResizing])

  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStart.current = { pointerX: event.clientX, width: sidebarWidthRef.current }
    setIsResizing(true)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = sidebarWidthRef.current - 4
    if (event.key === 'ArrowRight') nextWidth = sidebarWidthRef.current + 4
    if (event.key === 'Home') nextWidth = SIDEBAR_MIN_WIDTH
    if (event.key === 'End') nextWidth = maxWidth
    if (nextWidth === null) return
    event.preventDefault()
    updateSidebarWidth(nextWidth, true)
  }

  useEffect(() => {
    setPreviewOpen(false)
    if (collapsed && panel.current?.contains(document.activeElement)) trigger.current?.focus()
  }, [collapsed])

  useEffect(() => {
    if (desktop || !mobileOpen) return
    const previousFocus = document.activeElement
    panel.current?.querySelector<HTMLElement>('button, a, input')?.focus()
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus() }
  }, [desktop, mobileOpen])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(event.target.tagName))
      if (desktop && !editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setPreviewOpen(false)
        onToggle()
      }
      if (event.key === 'Escape' && (previewOpen || mobileOpen)) {
        setPreviewOpen(false)
        onCloseMobile()
        trigger.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [desktop, mobileOpen, onCloseMobile, onToggle, previewOpen])

  return (
    <>
      <WorkspaceNavigationRail activePage={activePage} activeBotSessionId={activeBotSessionId} botSidebar={toggleSidebarFromBot ? { expanded: visible, ref: trigger, toggle: onToggle } : undefined} botUnreadCount={botUnreadCount} footer={footer} onCloseMobile={onCloseMobile} onHistory={onHistory} onLeave={leave} onPeek={toggleSidebarFromBot ? undefined : peek} sidebarWidth={sidebarWidth} workspaceSlug={workspaceSlug} />
      <div className="workspace-sidebar-slot" data-collapsed={collapsed} data-resizing={isResizing} style={{ '--workspace-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        {collapsed && !toggleSidebarFromBot && <button aria-controls="workspace-chat-sidebar" aria-expanded={previewOpen} aria-label={t('展开侧边栏')} className="workspace-sidebar-trigger" onClick={() => { setPreviewOpen(false); onToggle() }} onMouseEnter={peek} onMouseLeave={leave} ref={trigger} title={t('展开侧边栏')} type="button"><img alt="" className="app-control-icon" src={`${iconPath}sidebar.svg`} /></button>}
        {mobileOpen && <button aria-label={t('关闭侧边栏')} className="fixed inset-0 z-30 bg-[var(--app-overlay)] md:hidden" onClick={onCloseMobile} type="button" />}
        <aside aria-label={t('聊天历史')} aria-modal={!desktop && mobileOpen ? true : undefined} role={!desktop && mobileOpen ? 'dialog' : undefined} className="workspace-chat-sidebar" data-collapsed={collapsed} data-mobile-open={mobileOpen} data-preview={previewOpen && collapsed} id="workspace-chat-sidebar" inert={!visible} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) leave() }} onFocus={clearLeave} onKeyDown={(event) => {
          if (desktop || !mobileOpen || event.key !== 'Tab') return
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')).filter((element) => !element.closest('[inert]'))
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }} onMouseEnter={clearLeave} onMouseLeave={leave} ref={panel}>
          {children}
        </aside>
        {!collapsed && desktop && <div aria-label={t('调整侧边栏宽度')} aria-orientation="vertical" aria-valuemax={maxWidth} aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuenow={sidebarWidth} aria-valuetext={t('{width} 像素', { width: sidebarWidth })} className="workspace-sidebar-resizer" data-resizing={isResizing} onDoubleClick={() => updateSidebarWidth(defaultWidth, true)} onKeyDown={resizeFromKeyboard} onPointerDown={resizeFromPointer} role="separator" tabIndex={0} title={t('拖动调整侧边栏宽度')}><span /></div>}
      </div>
    </>
  )
}
