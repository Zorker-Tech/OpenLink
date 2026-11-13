'use client'

import { AgentAvatar } from '@zorker/bot-demo'
import {
  isSessionMatch,
  sessionToAgent,
  type AppSidebarRow,
} from '@zorker/bot-demo/app'
import type { ThemeMode } from '@/components/account-drawer'
import {
  AppSidebarAccountFooter,
  AppSidebarWorkspaceHeader,
} from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { WorkspaceNavigation } from '@/components/workspace-navigation'
import type {
  ActiveWorkspaceSummary,
  PersonalWorkspaceSummary,
} from '@/components/workspace-switcher'
import { useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { useState } from 'react'

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
  personalWorkspace: PersonalWorkspaceSummary
  rows: AppSidebarRow[]
  themeMode: ThemeMode
  workspaceSlug: string
  onCloseMobile: () => void
  onNewAgent: () => void
  onSelect: (sessionId: string) => void
  onThemeChange: (mode: ThemeMode) => void
  onToggle: () => void
}

export function BotSidebar({
  activeId,
  activeWorkspace,
  avatarUrl,
  botUnreadCount,
  collapsed,
  email,
  mobileOpen,
  nickname,
  organizations,
  personalWorkspace,
  rows,
  themeMode,
  workspaceSlug,
  onCloseMobile,
  onNewAgent,
  onSelect,
  onThemeChange,
  onToggle,
}: BotSidebarProps) {
  const t = useT()
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredRows = rows.filter((row) => isSessionMatch(row.session, searchQuery, row.name))

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
        onHistory={() => setSearchOpen(true)}
        onToggle={onToggle}
        workspaceSlug={workspaceSlug}
      >
        <div className="flex shrink-0 flex-col gap-2 px-1.5 pt-2 pb-1">
          <AppSidebarWorkspaceHeader
            activeWorkspace={activeWorkspace}
            onAddOrganization={() => setOrganizationDialogOpen(true)}
            onSearch={() => setSearchOpen(true)}
            onToggle={onToggle}
            organizations={organizations}
            personalWorkspace={personalWorkspace}
          />
          <button
            className="flex h-[35px] w-full items-center gap-1.5 rounded-lg px-2.5 text-sm tracking-[-0.1504px] text-[var(--app-foreground)] hover:bg-[var(--app-hover)]"
            onClick={() => {
              onCloseMobile()
              onNewAgent()
            }}
            type="button"
          >
            <span aria-hidden="true" className="relative size-5 shrink-0">
              <img alt="" className="app-control-icon absolute left-[2.502px] top-[2.502px]" src="/openlink/navigation/new-chat-base.svg" />
              <img alt="" className="app-control-icon absolute left-[6.798px] top-[2.398px]" src="/openlink/navigation/new-chat-pen.svg" />
            </span>
            <span>New Bot</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-3 pb-3 [scrollbar-width:thin]">
          <div className="flex min-w-0 flex-col gap-1">
            {rows.map((row) => {
              const active = row.session.id === activeId
              const agent = sessionToAgent(row.session, row.name)
              return (
                <button
                  aria-current={active ? 'page' : undefined}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${active ? 'bg-[var(--app-selected,var(--app-active))]' : 'hover:bg-[var(--app-surface)]'}`}
                  key={row.session.id}
                  onClick={() => {
                    onCloseMobile()
                    onSelect(row.session.id)
                  }}
                  title={row.name}
                  type="button"
                >
                  <span className="relative flex size-8 shrink-0 items-center justify-center">
                    <AgentAvatar
                      agent={agent}
                      assetBase="/zorker-bot-demo"
                      className={row.session.isDraft ? 'zbd-app-avatar-new' : undefined}
                      size={32}
                    />
                    {row.unread ? <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-[#ff453a] ring-2 ring-[var(--app-background)]" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 tracking-[-0.15px] text-[var(--app-foreground)]">{row.name}</span>
                      <span className="shrink-0 text-[12px] leading-4 text-[var(--app-subtle-foreground)]" suppressHydrationWarning>{row.time}</span>
                    </span>
                    <span className="mt-px block truncate text-[12px] leading-4 text-[var(--app-muted)]">{row.preview || 'No messages yet'}</span>
                  </span>
                </button>
              )
            })}
            {!rows.length ? <p className="px-2 py-1 text-xs text-[var(--app-subtle-foreground)]">No bots yet</p> : null}
          </div>
        </div>
      </WorkspaceNavigation>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('搜索聊天')}</DialogTitle></DialogHeader>
          <input
            aria-label={t('搜索聊天')}
            autoFocus
            className="h-10 w-full rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm outline-none focus:border-[var(--app-focus-ring)]"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('搜索聊天')}
            type="search"
            value={searchQuery}
          />
          <div className="max-h-[50vh] overflow-y-auto">
            {filteredRows.map((row) => (
              <button
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-hover)]"
                key={row.session.id}
                onClick={() => {
                  setSearchOpen(false)
                  onCloseMobile()
                  onSelect(row.session.id)
                }}
                type="button"
              >
                <AgentAvatar
                  agent={sessionToAgent(row.session, row.name)}
                  assetBase="/zorker-bot-demo"
                  size={24}
                />
                <span className="min-w-0 flex-1">
                  <span className="block w-full truncate text-sm text-[var(--app-foreground)]">{row.name}</span>
                  <span className="block w-full truncate text-xs text-[var(--app-muted)]">{row.preview || 'No messages yet'}</span>
                </span>
              </button>
            ))}
            {!filteredRows.length ? <p className="px-3 py-6 text-center text-sm text-[var(--app-muted)]">{t('暂无聊天')}</p> : null}
          </div>
        </DialogContent>
      </Dialog>

      <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
    </>
  )
}
