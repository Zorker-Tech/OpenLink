'use client'

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector'
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { PromptAddMenu } from '@/components/prompt-add-menu'
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
import { createChatSessionAction } from '@/app/chat/actions'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ProjectSummary } from '@/lib/projects'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import { BookOpenText, Code2, MoreHorizontal, Pencil, Plus, Send, Share2 } from 'lucide-react'
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
}

export interface SidebarChatRuntime {
  speed: number
  state: OrbState
}

const IDLE_CHAT_RUNTIME: SidebarChatRuntime = { speed: 0.25, state: 'solving' }

function SidebarChatMenu({ onRename, onShare }: SidebarChatMenuProps) {
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
    <div className={`flex h-8 w-full items-center rounded-md text-sm tracking-[-0.1504px] transition-colors ${active ? 'bg-[var(--app-selected,var(--app-active))] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]'}`}>
      <button aria-current={active ? 'page' : undefined} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-inherit" onClick={onClick} type="button">
        {chatRuntime
          ? <ThinkingOrb aria-label={chatRuntime.state} className="shrink-0" size={20} speed={chatRuntime.speed} state={chatRuntime.state} />
          : <img alt="" className="app-nav-icon size-4 shrink-0" src={icon} />}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {chatMenu ? <SidebarChatMenu {...chatMenu} /> : <span className="w-2 shrink-0" />}
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
  projects,
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
  projects?: ProjectSummary[]
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
      }
    : undefined

  return (
    <>
      <AppSidebarFrame collapsed={collapsed} mobileOpen={mobileOpen} onCloseMobile={onCloseMobile}>
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
                    : undefined}
              />
            ))}
          </nav>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-[13px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                        className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-[12px] font-medium tracking-[-0.05px] text-[var(--app-subtle)] outline-none hover:bg-[var(--app-surface)] hover:text-[var(--app-muted)] focus-visible:ring-2 focus-visible:ring-[var(--app-control-border)]"
                        onClick={() => setCollapsedChatGroups((current) => ({ ...current, [group.projectId]: groupOpen }))}
                        type="button"
                      >
                        <img alt="" className={`app-control-icon size-3 transition-transform duration-200 ${groupOpen ? 'rotate-90' : ''}`} src="/openlink/app/section-chevron.svg" />
                        <span className="min-w-0 flex-1 truncate text-left">{groupLabel}</span>
                      </button>
                      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${groupOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} id={`sidebar-project-chats-${group.projectId}`}>
                        <div className="flex min-w-0 flex-col gap-1.5 overflow-hidden pl-1">
                          {group.chats.map((chat) => {
                            const active = activeChatId === chat.id
                            return <SidebarItem active={active} chatMenu={active ? activeChatMenu : undefined} chatRuntime={active ? activeChatRuntime ?? IDLE_CHAT_RUNTIME : IDLE_CHAT_RUNTIME} icon="/openlink/app/chat.svg" key={chat.id} label={active && activeChatLabel ? activeChatLabel : chat.title} onClick={() => router.push(`/${chat.userId}/cchat/${chat.id}`)} />
                          })}
                        </div>
                      </div>
                    </section>
                  )
                })}
                {!chatSessions.length && <p className="px-2 py-1 text-xs text-[var(--app-subtle)]">暂无聊天</p>}
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
              <button className="flex h-12 w-full items-center justify-center rounded-lg border border-dashed border-[var(--app-control-border)] text-xs text-[var(--app-subtle)] hover:bg-[var(--app-surface)]" onClick={() => router.push(`/app/${activeWorkspace.slug}/projects`)} type="button">暂无项目</button>
            )}
          </section>}
        </div>

        <AppSidebarAccountFooter activeWorkspace={activeWorkspace} avatarUrl={avatarUrl} email={email} nickname={nickname} onOpenOrganization={() => setOrganizationDialogOpen(true)} onThemeChange={onThemeChange} organizations={organizations} themeMode={themeMode} />

      </AppSidebarFrame>
      <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
    </>
  )
}

function WorkspacePrompt({
  configuredModels,
  defaultProject,
  initialPrompt,
  initialProjectId,
  projects,
  workspaceSlug,
}: {
  configuredModels: ConfiguredModelOption[]
  defaultProject: ProjectSummary
  initialPrompt: string
  initialProjectId?: string
  projects: ProjectSummary[]
  workspaceSlug: string
}) {
  const router = useRouter()
  const [input, setInput] = useState(initialPrompt)
  const initialModel = configuredModels.find((model) => model.isDefault) ?? configuredModels[0] ?? null
  const [selectedModelId, setSelectedModelId] = useState(initialModel?.id ?? '')
  const selectedModel = configuredModels.find((model) => model.id === selectedModelId) ?? initialModel
  const modelGroups = configuredModels.reduce<Map<string, ConfiguredModelOption[]>>((groups, model) => {
    const providerModels = groups.get(model.providerName) ?? []
    providerModels.push(model)
    groups.set(model.providerName, providerModels)
    return groups
  }, new Map())
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false)
  const selectableProjects = projects.filter((project) => !project.is_default)
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(
    selectableProjects.find((project) => project.id === initialProjectId) ?? null,
  )
  const [submitError, setSubmitError] = useState<string | null>(null)
  const runtimeProject = selectedProject ?? defaultProject
  const runtimeReady = runtimeProject.status === 'active' && runtimeProject.runtime_status === 'ready'

  return (
    <div className="flex w-full max-w-[700px] flex-col">
      <div className="flex h-[22px] items-center justify-between px-4">
        <span className="text-sm font-bold tracking-[-0.2px] text-[var(--app-foreground)]">Zorker</span>
        <div aria-label="运行环境" className="flex items-center gap-px rounded-full bg-[var(--app-home-mode-track)] p-px text-[13px]">
          <button aria-disabled className="rounded-full px-3 py-1 text-[var(--app-home-mode-muted)]" disabled title="Cloud 即将推出" type="button">Cloud</button>
          <span aria-current="true" className="rounded-full border border-[var(--app-home-mode-border)] bg-[var(--app-home-mode-active)] px-3 py-1 text-[var(--app-home-mode-foreground)] shadow-[0_1px_2px_var(--app-home-mode-shadow)]">Local</span>
        </div>
      </div>
    <PromptInput
      className="mt-3 w-full max-w-[700px] [&>[data-slot=input-group]]:h-[122px] [&>[data-slot=input-group]]:min-h-[122px] [&>[data-slot=input-group]]:rounded-[20px] [&>[data-slot=input-group]]:border-[var(--app-home-composer-border)] [&>[data-slot=input-group]]:bg-[var(--app-home-composer-background)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[var(--app-home-composer-border-focus)] [&>[data-slot=input-group]]:focus-within:ring-0"
      onSubmit={async ({ text }) => {
        const prompt = text.trim()
        if (!prompt) return
        if (!runtimeReady) {
          setSubmitError('项目环境仍在初始化，完成后即可创建对话。')
          return
        }
        setSubmitError(null)
        const result = await createChatSessionAction({
          prompt,
          workspaceSlug,
          projectId: selectedProject?.id ?? null,
          providerId: selectedModel?.providerId,
          modelId: selectedModel?.modelId,
        })
        if (result.path) router.push(result.path)
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="描述你想创建的内容"
          className="min-h-[64px]! px-4 pt-4 text-[14px] leading-5 text-[var(--app-home-composer-foreground)] placeholder:text-[var(--app-home-composer-placeholder)]"
          onChange={(event) => setInput(event.currentTarget.value)}
          disabled={!runtimeReady}
          placeholder={runtimeReady ? '描述你想构建的内容，或向 OpenLink 提问' : '项目环境正在初始化…'}
          value={input}
        />
      </PromptInputBody>
      <PromptInputFooter className="h-10 px-3 pb-3">
        <PromptInputTools className="gap-0.5">
          <PromptAddMenu variant="home" />
          <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
            <ModelSelectorTrigger
              render={
                <PromptInputButton className="h-7 max-w-[220px] gap-1 rounded-full px-2 text-[13px] font-medium text-[var(--app-home-composer-muted)] hover:bg-[var(--app-home-composer-hover)] hover:text-[var(--app-home-composer-foreground)]" type="button" />
              }
            >
              {selectedModel && <ModelSelectorLogo className="size-4" provider={selectedModel.logo} />}
              <span>{selectedModel?.name ?? '配置模型'}</span>
              <img alt="" className="app-control-icon size-4" src="/openlink/app/prompt-chevron.svg" />
            </ModelSelectorTrigger>
            <ModelSelectorContent className="w-[320px]" title="选择模型">
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索模型" />
              <ModelSelectorList className="max-h-64 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">没有已启用的模型</ModelSelectorEmpty>
                {[...modelGroups.entries()].map(([providerName, providerModels]) => (
                  <ModelSelectorGroup heading={providerName} key={providerName}>
                    {providerModels.map((model) => (
                      <ModelSelectorItem
                        className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                        key={model.id}
                        onSelect={() => {
                          setSelectedModelId(model.id)
                          setModelSelectorOpen(false)
                        }}
                        value={`${model.name} ${model.providerName} ${model.modelId}`}
                      >
                        <ModelSelectorLogo className="size-4" provider={model.logo} />
                        <ModelSelectorName>{model.name}</ModelSelectorName>
                        {model.isDefault && <span className="text-[11px] text-[var(--app-subtle)]">默认</span>}
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>
                ))}
                <ModelSelectorGroup heading="管理">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setModelSelectorOpen(false)
                      router.push('/settings/ai-providers')
                    }}
                    value="配置 AI 服务商"
                  >
                    <Plus className="size-4" />
                    <ModelSelectorName>配置 AI 服务商</ModelSelectorName>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <PromptInputSubmit aria-label="发送" className="size-7 rounded-full border border-[var(--app-home-submit-border)] bg-[var(--app-home-submit-background)] p-0 text-[var(--app-home-submit-foreground)] hover:opacity-90 disabled:cursor-wait disabled:opacity-40" disabled={!runtimeReady}>
            <Send aria-hidden className="size-3.5" />
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
      <div className="flex h-9 items-center gap-3 px-4 pt-3">
        <ModelSelector onOpenChange={setProjectSelectorOpen} open={projectSelectorOpen}>
          <ModelSelectorTrigger
            render={
              <button aria-label={`选择项目，当前 ${selectedProject?.name ?? '默认 Draft 项目'}`} className="-ml-1.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-xs text-[var(--app-project-selector-foreground)] hover:bg-[var(--app-project-selector-hover)]" type="button" />
            }
          >
            {selectedProject?.kind === 'research' ? <BookOpenText className="size-4" /> : <Code2 className="size-4" />}
            <span>{selectedProject?.name ?? 'Select Project'}</span>
          </ModelSelectorTrigger>
          <ModelSelectorContent className="w-[340px]" title="选择项目">
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索项目" />
              <ModelSelectorList className="max-h-72 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">没有找到项目</ModelSelectorEmpty>
                <ModelSelectorGroup heading="工作项目">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setSelectedProject(null)
                      setProjectSelectorOpen(false)
                    }}
                    value="无项目"
                  >
                    <span className="flex size-4 items-center justify-center rounded-full border border-current" />
                    <ModelSelectorName>无项目</ModelSelectorName>
                  </ModelSelectorItem>
                  {selectableProjects.map((project) => {
                    const Icon = project.kind === 'research' ? BookOpenText : Code2
                    const ready = project.status === 'active' && project.runtime_status === 'ready'
                    return (
                      <ModelSelectorItem
                        className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                        disabled={!ready}
                        key={project.id}
                        onSelect={() => {
                          setSelectedProject(project)
                          setProjectSelectorOpen(false)
                        }}
                        value={project.name}
                      >
                        <Icon className="size-4" />
                        <ModelSelectorName>{project.name}</ModelSelectorName>
                        <span className="text-xs text-[var(--app-subtle)]">{ready ? (project.kind === 'research' ? '研究' : '代码') : '等待初始化'}</span>
                      </ModelSelectorItem>
                    )
                  })}
                </ModelSelectorGroup>
                <ModelSelectorGroup heading="管理">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setProjectSelectorOpen(false)
                      router.push(`/app/${workspaceSlug}/projects`)
                    }}
                    value="创建或管理项目"
                  >
                    <Plus className="size-4" />
                    <ModelSelectorName>创建或管理项目</ModelSelectorName>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              </ModelSelectorList>
          </ModelSelectorContent>
        </ModelSelector>
      </div>
      {!runtimeReady && <p className="px-1 text-xs text-[var(--app-muted)]">{runtimeProject.name} 正在初始化 VM，项目进入活动状态后才能创建对话。</p>}
      {submitError && <p className="px-1 text-xs text-destructive" role="alert">{submitError}</p>}
    </div>
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
