'use client'

import { WorkspacePrompt } from '@/components/workspace-prompt'
import type { ThemeMode } from '@/components/account-drawer'
import { AppSidebarFrame } from '@/components/app-sidebar-frame'
import { AppSidebarAccountFooter, AppSidebarWorkspaceHeader } from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import { ThinkingOrb, type OrbState } from '@/components/thinking/src'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ProjectSummary } from '@/lib/projects'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import { MoreHorizontal, Pencil, Plus, Share2, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

interface AppWorkspaceProps {
  activeWorkspace: ActiveWorkspaceSummary
  personalWorkspace: PersonalWorkspaceSummary
  organizations: OrganizationSummary[]
  nickname: string
  email: string
  avatarUrl: string | null
  configuredModels: ConfiguredModelOption[]
  defaultProject: ProjectSummary
  chatSessions: ChatSessionSummary[]
  initialPrompt: string
  initialProjectId?: string
  projects: ProjectSummary[]
  workspaceSlug: string
}

const primaryNavigation = [
  { label: '搜索', icon: '/openlink/app/search.svg' },
  { label: '首页', icon: '/openlink/app/home.svg', active: true },
  { label: '项目', icon: '/openlink/app/projects.svg' },
  { label: '库', icon: '/openlink/app/library.svg' },
  { label: '知识库', icon: '/openlink/app/design-system.svg' },
  { label: '模板', icon: '/openlink/app/templates.svg' },
] as const

interface SidebarChatMenuProps {
  onRename?: () => void
  onShare: () => void
  onDelete?: () => void
}

export interface SidebarChatRuntime {
  speed: number
  state: OrbState
}

const IDLE_CHAT_RUNTIME: SidebarChatRuntime = { speed: 0.25, state: 'solving' }

function SidebarChatMenu({ onRename, onShare, onDelete }: SidebarChatMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button aria-label="聊天操作" className="mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] data-popup-open:bg-[var(--app-active)] data-popup-open:text-[var(--app-foreground)]" type="button" />}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        alignOffset={-6}
        className="w-[176px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0"
        side="right"
        sideOffset={7}
      >
        <DropdownMenuItem className="h-9 cursor-pointer gap-2.5 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]" onClick={onShare}>
          <Share2 className="size-4 text-[var(--app-muted)]" />
          <span>分享聊天</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="h-9 cursor-pointer gap-2.5 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]" disabled={!onRename} onClick={onRename}>
          <Pencil className="size-4 text-[var(--app-muted)]" />
          <span>重命名</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="h-9 cursor-pointer gap-2.5 rounded-md px-2.5 text-sm text-[var(--app-danger)] focus:bg-[var(--app-danger)]/10 focus:text-[var(--app-danger)]"
          disabled={!onDelete}
          onClick={onDelete}
        >
          <Trash2 className="size-4 text-[var(--app-danger)]" />
          <span>删除会话</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SidebarItem({
  label,
  icon,
  active = false,
  chatRuntime,
  chatMenu,
  onClick,
}: {
  label: string
  icon: string
  active?: boolean
  chatRuntime?: SidebarChatRuntime
  chatMenu?: SidebarChatMenuProps
  onClick?: () => void
}) {
  return (
    <div className={`group relative flex h-8 w-full items-center rounded-md text-sm tracking-[-0.1504px] transition-colors ${active ? 'bg-[var(--app-selected,var(--app-active))] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]'}`}>
      <button aria-current={active ? 'page' : undefined} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 pr-2 text-inherit" onClick={onClick} type="button">
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {chatRuntime
          ? <ThinkingOrb aria-label={chatRuntime.state} className="shrink-0" size={20} speed={chatRuntime.speed} state={chatRuntime.state} />
          : <img alt="" className="app-nav-icon size-4 shrink-0" src={icon} />}
      </button>
      {chatMenu ? (
        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <SidebarChatMenu {...chatMenu} />
        </div>
      ) : null}
    </div>
  )
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onToggle,
  onCloseMobile,
  nickname,
  email,
  avatarUrl,
  themeMode,
  activeWorkspace,
  personalWorkspace,
  organizations,
  onThemeChange,
  activeNavLabel,
  activeChatLabel,
  activeChatId,
  activeChatRuntime,
  chatSessions = [],
  onNewChat,
  onRenameActiveChat,
  onDeleteActiveChat,
  projects,
  secondaryPanel,
}: {
  collapsed: boolean
  mobileOpen: boolean
  onToggle: () => void
  onCloseMobile: () => void
  nickname: string
  email: string
  avatarUrl: string | null
  themeMode: ThemeMode
  activeWorkspace: ActiveWorkspaceSummary
  personalWorkspace: PersonalWorkspaceSummary
  organizations: OrganizationSummary[]
  onThemeChange: (mode: ThemeMode) => void
  activeNavLabel?: string
  activeChatLabel?: string
  activeChatId?: string
  activeChatRuntime?: SidebarChatRuntime
  chatSessions?: ChatSessionSummary[]
  onNewChat?: () => void
  onRenameActiveChat?: () => void
  onDeleteActiveChat?: () => void
  projects?: ProjectSummary[]
  /** Replaces the primary workspace navigation inside this same sidebar. */
  secondaryPanel?: React.ReactNode
}) {
  const router = useRouter()
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false)
  const [recentChatsOpen, setRecentChatsOpen] = useState(true)
  const [collapsedChatGroups, setCollapsedChatGroups] = useState<Record<string, boolean>>({})
  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.is_default),
    [projects],
  )
  const chatGroups = useMemo(() => {
    const groups = new Map<string, {
      projectId: string
      projectName: string
      projectIsDefault: boolean
      chats: ChatSessionSummary[]
    }>()

    for (const chat of chatSessions) {
      const projectId = chat.projectId || 'draft'
      const current = groups.get(projectId)
      if (current) {
        current.chats.push(chat)
        continue
      }
      groups.set(projectId, {
        projectId,
        projectName: chat.projectIsDefault ? 'Draft' : chat.projectName,
        projectIsDefault: chat.projectIsDefault,
        chats: [chat],
      })
    }

    return [...groups.values()]
  }, [chatSessions])

  const activeChatMenu = activeChatLabel
    ? {
        onRename: onRenameActiveChat,
        onShare: () => { void navigator.clipboard.writeText(window.location.href) },
        onDelete: onDeleteActiveChat,
      }
    : undefined

  return (
    <>
      <AppSidebarFrame collapsed={collapsed} mobileOpen={mobileOpen} onCloseMobile={onCloseMobile}>
        {secondaryPanel ? secondaryPanel : <>
        <div className="flex flex-col gap-3 py-2">
          <AppSidebarWorkspaceHeader activeWorkspace={activeWorkspace} onAddOrganization={() => setOrganizationDialogOpen(true)} onToggle={onToggle} organizations={organizations} personalWorkspace={personalWorkspace} />

          <div className="px-2">
            <button className="flex h-8 w-full items-center justify-center rounded-md bg-[var(--app-surface)] pl-7 pr-2 text-sm font-medium tracking-[-0.1504px] text-[var(--app-foreground)]" onClick={onNewChat ?? (() => router.push(`/app/${activeWorkspace.slug}`))} type="button">
              <span className="flex-1">新建聊天</span><img alt="" className="app-control-icon size-4" src="/openlink/app/new-chat-chevron.svg" />
            </button>
          </div>

          <nav aria-label="工作区导航" className="-mt-0.5 flex flex-col gap-0.5 px-2">
            {primaryNavigation.map((item) => (
              <SidebarItem
                key={item.label}
                {...item}
                active={activeNavLabel === item.label}
                onClick={item.label === '首页'
                  ? () => router.push(`/app/${activeWorkspace.slug}`)
                  : item.label === '项目'
                    ? () => router.push(`/app/${activeWorkspace.slug}/projects`)
                    : item.label === '知识库'
                      ? () => router.push(`/app/${activeWorkspace.slug}/knowledge`)
                    : undefined}
              />
            ))}
          </nav>
        </div>
        </>}

        {!secondaryPanel && <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-[13px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <section>
            <button
              aria-controls="sidebar-recent-chats-content"
              aria-expanded={recentChatsOpen}
              className="flex h-[30px] w-full items-start justify-between rounded-md px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)] outline-none hover:text-[var(--app-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--app-control-border)]"
              onClick={() => setRecentChatsOpen((value) => !value)}
              type="button"
            >
              <span>最近聊天</span><img alt="" className={`app-control-icon size-4 transition-transform duration-200 ${recentChatsOpen ? 'rotate-90' : ''}`} src="/openlink/app/section-chevron.svg" />
            </button>
            <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${recentChatsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} id="sidebar-recent-chats-content">
              <div className="flex flex-col gap-2 overflow-hidden">
                {chatGroups.map((group) => {
                  const groupOpen = collapsedChatGroups[group.projectId] !== true
                  const groupLabel = group.projectIsDefault ? 'Draft' : group.projectName
                  return (
                    <section key={group.projectId}>
                      <button
                        aria-controls={`sidebar-project-chats-${group.projectId}`}
                        aria-expanded={groupOpen}
                        className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-[12px] font-medium tracking-[-0.05px] text-[var(--app-subtle-foreground)] outline-none hover:bg-[var(--app-surface)] hover:text-[var(--app-muted)] focus-visible:ring-2 focus-visible:ring-[var(--app-control-border)]"
                        onClick={() => setCollapsedChatGroups((current) => ({ ...current, [group.projectId]: groupOpen }))}
                        type="button"
                      >
                        <img alt="" className={`app-control-icon size-3 transition-transform duration-200 ${groupOpen ? 'rotate-90' : ''}`} src="/openlink/app/section-chevron.svg" />
                        <span className="min-w-0 flex-1 truncate text-left">{groupLabel}</span>
                      </button>
                      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${groupOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} id={`sidebar-project-chats-${group.projectId}`}>
                        <div className="flex min-w-0 flex-col gap-1.5 overflow-hidden pl-4">
                          {group.chats.map((chat) => {
                            const active = activeChatId === chat.id
                            return <SidebarItem active={active} chatMenu={active ? activeChatMenu : undefined} chatRuntime={active ? activeChatRuntime ?? IDLE_CHAT_RUNTIME : IDLE_CHAT_RUNTIME} icon="/openlink/app/chat.svg" key={chat.id} label={active && activeChatLabel ? activeChatLabel : chat.title} onClick={() => router.push(`/${chat.userId}/cchat/${chat.id}`)} />
                          })}
                        </div>
                      </div>
                    </section>
                  )
                })}
                {!chatSessions.length && <p className="px-2 py-1 text-xs text-[var(--app-subtle-foreground)]">暂无聊天</p>}
              </div>
            </div>
          </section>

          {projects !== undefined && <section className="mt-5">
            <div className="flex h-[30px] items-start justify-between px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)]">
              <span>项目</span>
              <button aria-label="查看项目" className="flex size-5 items-center justify-center rounded hover:bg-[var(--app-surface)]" onClick={() => router.push(`/app/${activeWorkspace.slug}/projects`)} type="button"><Plus className="size-3.5" /></button>
            </div>
            {visibleProjects.length ? (
              <div className="flex flex-col gap-0.5">
                {visibleProjects.slice(0, 4).map((project) => (
                  <SidebarItem
                    icon="/openlink/app/projects.svg"
                    key={project.id}
                    label={project.name}
                    onClick={() => router.push(`/app/${activeWorkspace.slug}?project=${project.id}`)}
                  />
                ))}
              </div>
            ) : (
              <button className="flex h-12 w-full items-center justify-center rounded-lg border border-dashed border-[var(--app-control-border)] text-xs text-[var(--app-subtle-foreground)] hover:bg-[var(--app-surface)]" onClick={() => router.push(`/app/${activeWorkspace.slug}/projects`)} type="button">暂无项目</button>
            )}
          </section>}
        </div>}

        <AppSidebarAccountFooter activeWorkspace={activeWorkspace} avatarUrl={avatarUrl} email={email} nickname={nickname} onOpenOrganization={() => setOrganizationDialogOpen(true)} onThemeChange={onThemeChange} organizations={organizations} themeMode={themeMode} />

      </AppSidebarFrame>
      <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
    </>
  )
}

export function AppWorkspace({
  activeWorkspace,
  personalWorkspace,
  organizations,
  nickname,
  email,
  avatarUrl,
  configuredModels,
  defaultProject,
  chatSessions,
  initialPrompt,
  initialProjectId,
  projects,
  workspaceSlug,
}: AppWorkspaceProps) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [composerVersion, setComposerVersion] = useState(0)

  useEffect(() => {
    const runtimes = [defaultProject, ...projects]
    if (!runtimes.some((project) => project.status === 'waiting' || project.runtime_status !== 'ready')) return
    const refresh = window.setInterval(() => router.refresh(), 2_500)
    return () => window.clearInterval(refresh)
  }, [defaultProject, projects, router])

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme)

    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updateSystemTheme = () => setSystemLight(media.matches)
    updateSystemTheme()
    media.addEventListener('change', updateSystemTheme)
    return () => media.removeEventListener('change', updateSystemTheme)
  }, [])

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode)
    window.localStorage.setItem('openlink-theme', mode)
  }
  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  useEffect(() => {
    const root = document.documentElement
    if (activeTheme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [activeTheme])

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className="openlink-app-shell flex h-dvh min-h-[500px] overflow-hidden" data-theme={activeTheme}>
        <Sidebar
          activeWorkspace={activeWorkspace}
          avatarUrl={avatarUrl}
          chatSessions={chatSessions}
          collapsed={collapsed}
          email={email}
          mobileOpen={mobileOpen}
          nickname={nickname}
          onThemeChange={handleThemeChange}
          onCloseMobile={() => setMobileOpen(false)}
          onNewChat={() => {
            router.replace(`/app/${activeWorkspace.slug}`)
            setComposerVersion((value) => value + 1)
          }}
          organizations={organizations}
          personalWorkspace={personalWorkspace}
          projects={projects}
          themeMode={themeMode}
          activeNavLabel="首页"
          onToggle={() => {
            if (mobileOpen) {
              setMobileOpen(false)
              setCollapsed(true)
            } else {
              setCollapsed((value) => !value)
            }
          }}
        />
        <main className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--app-background)] px-6">
          <header className="absolute inset-x-0 top-0 flex h-12 items-center border-b border-[var(--app-border)] px-3 md:border-transparent">
            <button aria-label="打开侧边栏" className="flex size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)] md:hidden" onClick={() => { setCollapsed(false); setMobileOpen(true) }} type="button">
              <span className="flex w-4 flex-col gap-1"><i className="h-px w-4 bg-[var(--app-muted)]" /><i className="h-px w-4 bg-[var(--app-muted)]" /><i className="h-px w-4 bg-[var(--app-muted)]" /></span>
            </button>
            <span className="ml-2 truncate text-sm font-medium text-[var(--app-foreground)] md:hidden">{activeWorkspace.name}</span>
            {collapsed && (
              <button aria-label="展开侧边栏" className="hidden size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)] md:flex" onClick={() => setCollapsed(false)} type="button">
                <img alt="" className="app-control-icon size-4" src="/openlink/app/sidebar-expand.svg" />
              </button>
            )}
          </header>
          <div className="flex w-full justify-center">
            <WorkspacePrompt
              configuredModels={configuredModels}
              defaultProject={defaultProject}
              key={composerVersion}
              initialProjectId={initialProjectId}
              initialPrompt={initialPrompt}
              projects={projects}
              workspaceSlug={workspaceSlug}
            />
          </div>
        </main>
      </div>
    </OpenLinkThemeProvider>
  )
}
