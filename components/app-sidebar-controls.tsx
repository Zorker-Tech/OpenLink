'use client'

import { AccountDrawer, type ThemeMode } from '@/components/account-drawer'
import {
  WorkspaceSwitcher,
  type ActiveWorkspaceSummary,
  type PersonalWorkspaceSummary,
} from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import { useT } from '@/lib/i18n/client'
import { useEffect, useRef, useState } from 'react'

export function AppSidebarWorkspaceHeader({
  activeWorkspace,
  onAddOrganization,
  onToggle,
  onSearch,
  organizations,
  personalWorkspace,
}: {
  activeWorkspace: ActiveWorkspaceSummary
  onAddOrganization: () => void
  onToggle: () => void
  onSearch?: () => void
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
}) {
  const t = useT()
  return (
    <div className="flex h-9 items-center gap-1 px-1">
      <WorkspaceSwitcher activeWorkspace={activeWorkspace} onAddOrganization={onAddOrganization} organizations={organizations} personalWorkspace={personalWorkspace} />
      {onSearch && <button aria-label={t('搜索聊天')} className="flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--app-hover)]" onClick={onSearch} type="button"><img alt="" className="app-control-icon" src="/openlink/navigation/search.svg" /></button>}
      <button aria-label={t('收起侧边栏')} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-surface)]" onClick={onToggle} type="button">
        <img alt="" className="app-control-icon" src="/openlink/navigation/sidebar.svg" />
      </button>
    </div>
  )
}

const USER_AVATAR_COLORS = [
  '#145A5A',
  '#1F6F64',
  '#2F684A',
  '#4B6A3D',
  '#6B713A',
  '#8A6A2B',
  '#A26224',
  '#A84F2B',
  '#B05438',
  '#9E3D3D',
  '#B94B45',
  '#9C4D35',
  '#1B6475',
  '#245D82',
  '#405B72',
] as const

function getUserAvatarColor(seed: string) {
  let hash = 2166136261
  const normalizedSeed = seed.trim().toLowerCase()
  for (let index = 0; index < normalizedSeed.length; index += 1) {
    hash = Math.imul(hash ^ normalizedSeed.charCodeAt(index), 16777619)
  }
  return USER_AVATAR_COLORS[(hash >>> 0) % USER_AVATAR_COLORS.length]
}

function SidebarUserAvatar({ avatarUrl, email, nickname }: { avatarUrl: string | null; email: string; nickname: string }) {
  const initial = nickname.trim().charAt(0).toUpperCase() || 'O'
  return (
    <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: getUserAvatarColor(email || nickname) }}>
      {avatarUrl ? <img alt="" className="size-full object-cover" src={avatarUrl} /> : initial}
    </span>
  )
}

export function AppSidebarAccountFooter({
  compact = false,
  activeWorkspace,
  avatarUrl,
  email,
  nickname,
  onOpenOrganization,
  onThemeChange,
  organizations,
  themeMode,
}: {
  compact?: boolean
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  email: string
  nickname: string
  onOpenOrganization: () => void
  onThemeChange: (mode: ThemeMode) => void
  organizations: OrganizationSummary[]
  themeMode: ThemeMode
}) {
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!accountDrawerOpen) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setAccountDrawerOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAccountDrawerOpen(false) }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [accountDrawerOpen])
  return (
    <div className={compact ? 'workspace-rail-account relative shrink-0' : 'relative flex h-12 shrink-0 items-end gap-1 px-2 pb-3'} ref={root}>
      {accountDrawerOpen && (
        <AccountDrawer
          activeWorkspace={activeWorkspace}
          avatarUrl={avatarUrl}
          email={email}
          mode={themeMode}
          nickname={nickname}
          onOpenOrganization={() => { setAccountDrawerOpen(false); onOpenOrganization() }}
          onModeChange={onThemeChange}
          organizations={organizations}
        />
      )}
      <button aria-label={compact ? email : undefined} aria-expanded={accountDrawerOpen} className={compact ? 'workspace-rail-button' : 'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-0.5 hover:bg-[var(--app-surface)]'} onClick={() => setAccountDrawerOpen((value) => !value)} title={email} type="button">
        <SidebarUserAvatar avatarUrl={avatarUrl} email={email} nickname={nickname} />
        {!compact && <span className="min-w-0 flex-1 truncate text-left text-sm tracking-[-0.1504px] text-[var(--app-foreground)]">{email}</span>}
      </button>
    </div>
  )
}
