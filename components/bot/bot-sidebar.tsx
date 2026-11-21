'use client'

import { ContextMenu } from '@base-ui/react/context-menu'
import { AgentAvatar as MemberAvatar } from '@zorker/avatar'
import { AgentAvatar } from '@zorker/bot-demo'
import { isSessionMatch, sessionToAgent, type AppSidebarRow } from '@zorker/bot-demo/app'
import { ArrowDown, ChevronRight, Ellipsis, Eye, EyeOff, FolderPlus, ListFilter, Pin, Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { ThemeMode } from '@/components/account-drawer'
import { AppSidebarAccountFooter } from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useOpenLinkTheme } from '@/components/ui/theme-scope'
import { WorkspaceNavigation } from '@/components/workspace-navigation'
import type { ActiveWorkspaceSummary } from '@/components/workspace-switcher'
import type { BotSummary } from '@/lib/bot-types'
import { useLocale, useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'

export type BotSidebarRow = Omit<AppSidebarRow, 'time'> & { members?: BotSummary['members'] }

type BotSidebarProps = {
  activeId: string
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  botUnreadCount: number
  collapsed: boolean
  email: string
  mobileOpen: boolean
  nickname: string
  organizations: OrganizationSummary[]
  rows: BotSidebarRow[]
  themeMode: ThemeMode
  workspaceSlug: string
  onCloseMobile: () => void
  onNewAgent: () => void
  onSelect: (sessionId: string) => void
  onThemeChange: (mode: ThemeMode) => void
  onToggle: () => void
}

type SidebarSection = { id: string; name: string; collapsed: boolean }
type SidebarLayout = {
  pins: string[]
  hidden: string[]
  sections: SidebarSection[]
  placement: Record<string, string>
  unreadOnly: boolean
  gridPins: boolean
}
type SidebarAction = { id: string; label: string; run: () => void }

const EMPTY_LAYOUT: SidebarLayout = { pins: [], hidden: [], sections: [], placement: {}, unreadOnly: false, gridPins: true }
const DRAG_TYPE = 'application/x-openlink-bot'
const SIDEBAR_SIZING = { defaultWidth: 320, maxWidth: 400, storageKey: 'openlink-bot-sidebar-width' }

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : []
}

function readLayout(key: string): SidebarLayout {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<SidebarLayout> | null
    if (!value) return EMPTY_LAYOUT
    const sections = Array.isArray(value.sections) ? value.sections.filter((section) =>
      typeof section?.id === 'string' && typeof section.name === 'string' && section.name.trim().length > 0) : []
    const placement = value.placement && typeof value.placement === 'object' && !Array.isArray(value.placement)
      ? Object.fromEntries(Object.entries(value.placement).filter(([, id]) => sections.some((section) => section.id === id)))
      : {}
    return { pins: stringList(value.pins), hidden: stringList(value.hidden), sections, placement, unreadOnly: value.unreadOnly === true, gridPins: value.gridPins !== false }
  } catch {
    return EMPTY_LAYOUT
  }
}

function keepDrag(event: DragEvent<HTMLElement>) {
  if (event.dataTransfer.types.includes(DRAG_TYPE)) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }
}

function navigateRows(event: KeyboardEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute('data-bot-select')) return
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (!step && event.key !== 'Home' && event.key !== 'End') return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-bot-select]')).filter((button) => !button.closest('[hidden]'))
  const index = rows.indexOf(event.target)
  const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : rows[index + step]
  if (next) {
    event.preventDefault()
    next.focus()
  }
}

export function BotSidebar({
  activeId, activeWorkspace, avatarUrl, botUnreadCount, collapsed, email, mobileOpen, nickname,
  organizations, rows, themeMode, workspaceSlug, onCloseMobile, onNewAgent, onSelect, onThemeChange, onToggle,
}: BotSidebarProps) {
  const t = useT()
  const locale = useLocale()
  const theme = useOpenLinkTheme()
  const storageKey = 'openlink-bot-sidebar:' + JSON.stringify([email, workspaceSlug])
  const [saved, setSaved] = useState<{ key: string; layout: SidebarLayout } | null>(null)
  const layout = saved?.key === storageKey ? saved.layout : EMPTY_LAYOUT
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [unreadBelow, setUnreadBelow] = useState(false)
  const [sectionDraft, setSectionDraft] = useState<{ id?: string; name: string } | null>(null)

  useEffect(() => { setSaved({ key: storageKey, layout: readLayout(storageKey) }) }, [storageKey])
  useEffect(() => {
    if (saved?.key !== storageKey) return
    try { window.localStorage.setItem(storageKey, JSON.stringify(saved.layout)) } catch {}
  }, [saved, storageKey])

  const unreadBelowViewport = useCallback(() => {
    const list = listRef.current
    if (!list || !list.clientHeight) return undefined
    const edge = list.getBoundingClientRect().bottom - 12
    return Array.from(list.querySelectorAll<HTMLElement>('[data-bot-unread]')).find((row) =>
      !row.closest('[hidden]') && row.getBoundingClientRect().bottom > edge)
  }, [])
  const measureUnread = useCallback(() => setUnreadBelow(Boolean(unreadBelowViewport())), [unreadBelowViewport])

  useEffect(() => {
    measureUnread()
    const list = listRef.current
    const content = contentRef.current
    if (!list || !content) return
    const observer = new ResizeObserver(measureUnread)
    observer.observe(list)
    observer.observe(content)
    return () => observer.disconnect()
  }, [layout, measureUnread, rows, showHidden])

  const jumpToUnread = () => {
    const list = listRef.current
    const row = unreadBelowViewport()
    if (!list || !row) return
    const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    list.scrollTo({ top: list.scrollTop + offset - list.clientHeight / 3, behavior: motion })
  }

  const update = (change: (layout: SidebarLayout) => SidebarLayout) => {
    setSaved((current) => ({ key: storageKey, layout: change(current?.key === storageKey ? current.layout : readLayout(storageKey)) }))
  }

  const recent = [...rows].sort((a, b) => b.session.lastActivityMs - a.session.lastActivityMs)
  const visible = recent.filter(({ session, unread }) =>
    !layout.hidden.includes(session.id) && (!layout.unreadOnly || unread || session.id === activeId))
  const visibleById = new Map(visible.map((row) => [row.session.id, row]))
  const pinned = layout.gridPins ? layout.pins.flatMap((id) => visibleById.get(id) ?? []) : []
  const unpinned = layout.gridPins ? visible.filter(({ session }) => !layout.pins.includes(session.id)) : visible
  const hidden = recent.filter(({ session }) => layout.hidden.includes(session.id))
  const results = recent.filter((row) => isSessionMatch(row.session, searchQuery, row.name)
    || row.preview.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
  const select = (id: string) => {
    onCloseMobile()
    onSelect(id)
  }

  const setPin = (id: string, target?: string) => update((current) => {
    const slot = target ? current.pins.indexOf(target) : -1
    const pins = current.pins.filter((pin) => pin !== id)
    pins.splice(slot >= 0 ? slot : pins.length, 0, id)
    return { ...current, pins }
  })

  const place = (id: string, sectionId?: string) => update((current) => {
    const placement = { ...current.placement }
    if (sectionId && current.sections.some((section) => section.id === sectionId)) placement[id] = sectionId
    else delete placement[id]
    return { ...current, placement, pins: current.pins.filter((pin) => pin !== id) }
  })

  const drop = (event: DragEvent<HTMLElement>, move: (id: string) => void) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer.getData(DRAG_TYPE)
    if (rows.some((row) => row.session.id === id)) move(id)
  }

  const saveSection = (draft: NonNullable<typeof sectionDraft>) => {
    const name = draft.name.trim()
    if (!name) return
    const id = draft.id ?? crypto.getRandomValues(new Uint32Array(3)).join('-')
    update((current) => ({
      ...current,
      sections: draft.id
        ? current.sections.map((section) => section.id === id ? { ...section, name } : section)
        : [...current.sections, { id, name, collapsed: false }],
    }))
    setSectionDraft(null)
  }

  const rowView = (row: BotSidebarRow, variant: 'row' | 'pin' | 'hidden' = 'row') => {
    const id = row.session.id
    const active = id === activeId
    const pinned = layout.pins.includes(id)
    const isHidden = variant === 'hidden'
    const actions: SidebarAction[] = isHidden ? [
      { id: 'show', label: 'Show in sidebar', run: () => update((current) => ({ ...current, hidden: current.hidden.filter((hidden) => hidden !== id) })) },
    ] : [
      pinned
        ? { id: 'unpin', label: 'Unpin', run: () => update((current) => ({ ...current, pins: current.pins.filter((pin) => pin !== id) })) }
        : { id: 'pin', label: 'Pin to sidebar', run: () => setPin(id) },
      ...(pinned || layout.placement[id] ? [{ id: 'recent', label: 'Move to Recent', run: () => place(id) }] : []),
      ...layout.sections.filter((section) => pinned || section.id !== layout.placement[id]).map((section) => ({
        id: section.id, label: `Move to ${section.name}`, run: () => place(id, section.id),
      })),
      { id: 'hide', label: 'Hide from sidebar', run: () => update((current) => ({ ...current, hidden: [...new Set([...current.hidden, id])] })) },
    ]

    return (
      <ContextMenu.Root key={id}>
        <ContextMenu.Trigger
          className="bot-sidebar-entry"
          data-active={active ? '' : undefined}
          data-bot-unread={row.unread && !isHidden ? '' : undefined}
          data-variant={variant}
          onDragOver={variant === 'pin' ? keepDrag : undefined}
          onDrop={variant === 'pin' ? (event) => drop(event, (source) => { if (source !== id) setPin(source, id) }) : undefined}
          render={<div />}
        >
          <button
            aria-current={active ? 'page' : undefined}
            aria-label={row.unread ? `${row.name}, unread` : row.name}
            className="bot-sidebar-select"
            data-bot-select=""
            draggable={!isHidden}
            onClick={() => select(id)}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            title={row.name}
            type="button"
          >
            <span className="bot-sidebar-avatar">
              {row.members?.length ? (
                <span aria-hidden="true" className="bot-sidebar-members">
                  {row.members.slice(0, 4).map((member) => (
                    <MemberAvatar color={member.avatarColor} interactive={false} key={member.id} shape={member.avatarShape} size={variant === 'pin' ? 36 : 27} />
                  ))}
                </span>
              ) : (
                <AgentAvatar
                  agent={sessionToAgent(row.session, row.name)}
                  assetBase="/zorker-bot-demo"
                  className={row.session.isDraft ? 'zbd-app-avatar-new' : undefined}
                  size={variant === 'pin' ? 74 : 48}
                />
              )}
              {pinned && !layout.gridPins ? <Pin aria-hidden="true" className="bot-sidebar-pin-mark" size={11} /> : null}
            </span>
            <span className="bot-sidebar-row-copy">
              <span className="bot-sidebar-name">{row.name}</span>
              {variant !== 'pin' && row.preview ? <span className="bot-sidebar-preview">{row.preview}</span> : null}
            </span>
            {row.unread ? <span aria-hidden="true" className="bot-sidebar-unread" /> : null}
          </button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger aria-label={`Actions for ${row.name}`} className="bot-sidebar-icon bot-sidebar-row-menu" title={`Actions for ${row.name}`}>
              <Ellipsis aria-hidden="true" size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max max-w-64">
              {actions.map(({ id, label, run }) => <DropdownMenuItem key={id} onClick={run}>{label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-[80] outline-none">
            <ContextMenu.Popup className="bot-message-context-menu bot-sidebar-context-menu" data-theme={theme ? `bot-${theme}` : undefined}>
              {actions.map(({ id, label, run }) => <ContextMenu.Item className="bot-message-context-item" key={id} onClick={run}>{label}</ContextMenu.Item>)}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    )
  }

  return (
    <>
      <WorkspaceNavigation
        activePage={t('Bot')}
        botUnreadCount={botUnreadCount}
        collapsed={collapsed}
        footer={(
          <AppSidebarAccountFooter
            activeWorkspace={activeWorkspace}
            avatarUrl={avatarUrl}
            compact
            email={email}
            nickname={nickname}
            onOpenOrganization={() => setOrganizationDialogOpen(true)}
            onThemeChange={onThemeChange}
            organizations={organizations}
            themeMode={themeMode}
          />
        )}
        mobileOpen={mobileOpen}
        onCloseMobile={onCloseMobile}
        onHistory={() => { setSearchQuery(''); setSearchOpen(true) }}
        onToggle={onToggle}
        sidebarSizing={SIDEBAR_SIZING}
        toggleSidebarFromBot
        workspaceSlug={workspaceSlug}
      >
        <div className="bot-nav">
          <div className="bot-sidebar-header">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger aria-label="Organize bots" className="bot-sidebar-icon bot-sidebar-organize" title="Organize bots">
                <ListFilter aria-hidden="true" size={16} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-max">
                <DropdownMenuItem onClick={() => update((current) => ({ ...current, gridPins: !current.gridPins }))}>
                  {layout.gridPins ? 'Show pins in list' : 'Show pins as tiles'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => update((current) => ({ ...current, unreadOnly: !current.unreadOnly }))}>
                  {layout.unreadOnly ? 'Show all chats' : 'Show unread chats'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSectionDraft({ name: '' })}><FolderPlus /> New section</DropdownMenuItem>
                <DropdownMenuItem disabled={!hidden.length && !showHidden} onClick={() => setShowHidden((value) => !value)}>
                  {showHidden ? <EyeOff /> : <Eye />}{showHidden ? 'Hide hidden bots' : 'Show hidden bots'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button aria-label={t('搜索聊天')} className="bot-sidebar-icon bot-sidebar-header-action" onClick={() => { setSearchQuery(''); setSearchOpen(true) }} title={t('搜索聊天')} type="button">
              <Search aria-hidden="true" size={16} />
            </button>
            <button aria-label="New Bot" className="bot-sidebar-icon bot-sidebar-header-action" onClick={() => { onCloseMobile(); onNewAgent() }} title="New Bot" type="button">
              <Plus aria-hidden="true" size={18} />
            </button>
          </div>

          <div className="bot-sidebar-scroll" onKeyDown={navigateRows} onScroll={measureUnread} ref={listRef}>
            <div className="bot-sidebar-scroll-content" ref={contentRef}>
              {pinned.length ? (
                <section aria-label="Pinned" onDragOver={keepDrag} onDrop={(event) => drop(event, (id) => {
                  if (!layout.pins.includes(id)) setPin(id)
                })}>
                  <div className="bot-sidebar-pins">{pinned.map((row) => rowView(row, 'pin'))}</div>
                </section>
              ) : null}

              {layout.sections.map((section) => (
                <section aria-label={section.name} key={section.id} onDragOver={keepDrag} onDrop={(event) => drop(event, (id) => place(id, section.id))}>
                  <div className="bot-sidebar-section-bar">
                    <button aria-controls={`bot-section-${section.id}`} aria-expanded={!section.collapsed} className="bot-sidebar-section-title" onClick={() => update((current) => ({
                      ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, collapsed: !item.collapsed } : item),
                    }))} type="button">
                      <ChevronRight aria-hidden="true" size={13} /><span>{section.name}</span>
                    </button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger aria-label={`Actions for section ${section.name}`} className="bot-sidebar-icon"><Ellipsis aria-hidden="true" size={15} /></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-max">
                        <DropdownMenuItem onClick={() => setSectionDraft({ id: section.id, name: section.name })}>{t('重命名')}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => update((current) => ({
                          ...current,
                          sections: current.sections.filter(({ id }) => id !== section.id),
                          placement: Object.fromEntries(Object.entries(current.placement).filter(([, id]) => id !== section.id)),
                        }))}>Remove section</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="bot-sidebar-list" hidden={section.collapsed} id={`bot-section-${section.id}`}>
                    {unpinned.filter(({ session }) => layout.placement[session.id] === section.id).map((row) => rowView(row))}
                  </div>
                </section>
              ))}

              <section aria-label="Recent" onDragOver={keepDrag} onDrop={(event) => drop(event, (id) => place(id))}>
                <div className="bot-sidebar-list">
                  {unpinned.filter(({ session }) => !layout.placement[session.id]).map((row) => rowView(row))}
                </div>
                {!visible.length ? <p className="bot-sidebar-empty">{layout.unreadOnly ? 'No unread chats' : t('暂无聊天')}</p> : null}
              </section>
              {showHidden && hidden.length ? (
                <section aria-label="Hidden bots">
                  <h3 className="bot-sidebar-section-title"><EyeOff aria-hidden="true" size={12} /> Hidden</h3>
                  <div className="bot-sidebar-list">{hidden.map((row) => rowView(row, 'hidden'))}</div>
                </section>
              ) : null}
            </div>
          </div>
          {unreadBelow ? (
            <div className="bot-sidebar-unread-jump">
              <button onClick={jumpToUnread} type="button">
                <ArrowDown aria-hidden="true" size={14} /> {locale.startsWith('zh') ? '更多未读消息' : 'More unread messages'}
              </button>
            </div>
          ) : null}
        </div>
      </WorkspaceNavigation>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('搜索聊天')}</DialogTitle></DialogHeader>
          <input aria-label={t('搜索聊天')} autoFocus className="bot-sidebar-dialog-input" onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('搜索聊天')} type="search" value={searchQuery} />
          <div className="max-h-[50vh] overflow-y-auto">
            {results.map((row) => (
              <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-hover)]" key={row.session.id} onClick={() => { setSearchOpen(false); select(row.session.id) }} type="button">
                <AgentAvatar agent={sessionToAgent(row.session, row.name)} assetBase="/zorker-bot-demo" size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--app-foreground)]">{row.name}</span>
                  <span className="block truncate text-xs text-[var(--app-muted)]">{row.preview}</span>
                </span>
              </button>
            ))}
            {!results.length ? <p className="px-3 py-6 text-center text-sm text-[var(--app-muted)]">No matching chats</p> : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sectionDraft !== null} onOpenChange={(open) => { if (!open) setSectionDraft(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{sectionDraft?.id ? t('重命名') : 'New section'}</DialogTitle></DialogHeader>
          {sectionDraft ? (
            <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); saveSection(sectionDraft) }}>
              <input aria-label="Section name" autoFocus className="bot-sidebar-dialog-input" maxLength={60} onChange={(event) => setSectionDraft({ ...sectionDraft, name: event.target.value })} placeholder="Section name" value={sectionDraft.name} />
              <button className="bot-sidebar-save" disabled={!sectionDraft.name.trim()} type="submit">{t('保存')}</button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
    </>
  )
}
