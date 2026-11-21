'use client'

import { AgentAvatar } from '@zorker/bot-demo'
import {
  isSessionMatch,
  sessionToAgent,
  type AppSidebarRow,
} from '@zorker/bot-demo/app'
import Link from 'next/link'
import { Grid3X3, Plus, Search } from 'lucide-react'
import type { ThemeMode } from '@/components/account-drawer'
import { AppSidebarAccountFooter } from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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

/**
 * The Bot secondary sidebar: pinned Bots as tiles, the rest as rows, with
 * search and creation at the top and the viewer's account at the bottom.
 */
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
  const featured = rows.slice(0, 3)
  const rest = rows.slice(3)
  const viewerName = nickname || email || 'You'

  const select = (sessionId: string) => {
    onCloseMobile()
    onSelect(sessionId)
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
        onHistory={() => setSearchOpen(true)}
        onToggle={onToggle}
        toggleSidebarFromBot
        workspaceSlug={workspaceSlug}
      >
        <div className="bot-nav">
        <div className="bot-secondary-header">
          <button
            aria-label={t('搜索聊天')}
            className="bot-secondary-icon"
            onClick={() => setSearchOpen(true)}
            title={t('搜索聊天')}
            type="button"
          >
            <Search className="size-4" />
          </button>
          <button
            aria-label={t('New Bot')}
            className="bot-secondary-icon"
            onClick={() => {
              onCloseMobile()
              onNewAgent()
            }}
            title={t('New Bot')}
            type="button"
          >
            <Plus className="size-4" />
          </button>
        </div>

        {featured.length ? (
          <div className="bot-featured-grid">
            {featured.map((row) => {
              const active = row.session.id === activeId
              return (
                <button
                  aria-current={active ? 'page' : undefined}
                  aria-label={row.name}
                  className="bot-featured-tile"
                  data-active={active ? '' : undefined}
                  key={row.session.id}
                  onClick={() => select(row.session.id)}
                  title={row.name}
                  type="button"
                >
                  <AgentAvatar
                    agent={sessionToAgent(row.session, row.name)}
                    assetBase="/zorker-bot-demo"
                    className={row.session.isDraft ? 'zbd-app-avatar-new' : undefined}
                    size={40}
                  />
                  <span className="bot-featured-name">{row.name}</span>
                  {row.unread ? <span className="bot-featured-unread" /> : null}
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="bot-secondary-list">
          {rest.map((row) => {
            const active = row.session.id === activeId
            return (
              <button
                aria-current={active ? 'page' : undefined}
                className="bot-secondary-row"
                data-active={active ? '' : undefined}
                key={row.session.id}
                onClick={() => select(row.session.id)}
                title={row.name}
                type="button"
              >
                <span className="bot-secondary-avatar">
                  <AgentAvatar
                    agent={sessionToAgent(row.session, row.name)}
                    assetBase="/zorker-bot-demo"
                    className={row.session.isDraft ? 'zbd-app-avatar-new' : undefined}
                    size={32}
                  />
                  {row.unread ? <span className="bot-secondary-unread" /> : null}
                </span>
                <span className="bot-secondary-body">
                  <span className="bot-secondary-name">{row.name}</span>
                  <span className="bot-secondary-preview">{row.preview || 'No messages yet'}</span>
                </span>
              </button>
            )
          })}
          {!rows.length ? <p className="bot-secondary-empty">No bots yet</p> : null}
        </div>

        <div className="bot-secondary-footer">
          <span className="bot-secondary-user-avatar">
            {avatarUrl ? <img alt="" src={avatarUrl} /> : viewerName.slice(0, 1).toUpperCase()}
          </span>
          <span className="bot-secondary-user-name">{viewerName}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <button
                  aria-label="Workspace menu"
                  className="bot-secondary-icon"
                  title="Workspace menu"
                  type="button"
                />
              )}
            >
              <Grid3X3 className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={8}>
              <div className="px-2 py-1.5 text-[12px] font-medium text-[var(--app-muted)]">{activeWorkspace.name}</div>
              <DropdownMenuItem render={<Link href={`/app/${workspaceSlug}`} onClick={onCloseMobile} />}>{t('首页')}</DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/app/${workspaceSlug}/projects`} onClick={onCloseMobile} />}>{t('项目')}</DropdownMenuItem>
              <DropdownMenuItem render={<Link href={`/app/${workspaceSlug}/knowledge`} onClick={onCloseMobile} />}>{t('知识库')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSearchOpen(true)}>{t('搜索聊天')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setOrganizationDialogOpen(true)}>{t('组织')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onThemeChange(themeMode === 'dark' ? 'light' : 'dark')}>
                {themeMode === 'dark' ? t('浅色模式') : t('深色模式')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings" />}>{t('个人设置')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                  select(row.session.id)
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
