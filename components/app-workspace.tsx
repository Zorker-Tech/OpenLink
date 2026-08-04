'use client'

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
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
import { AccountDrawer, type ThemeMode } from '@/components/account-drawer'
import { useEffect, useState } from 'react'

interface AppWorkspaceProps {
  workspaceName: string
  nickname: string
  email: string
  avatarUrl: string | null
  initialPrompt: string
}

const primaryNavigation = [
  { label: '搜索', icon: '/openlink/app/search.svg' },
  { label: '首页', icon: '/openlink/app/home.svg', active: true },
  { label: '项目', icon: '/openlink/app/projects.svg' },
  { label: '库', icon: '/openlink/app/library.svg' },
  { label: '设计系统', icon: '/openlink/app/design-system.svg' },
  { label: '模板', icon: '/openlink/app/templates.svg' },
] as const

const recentChats = ['运行网站', 'New radix-nova project', 'Tooltip Provider 错误'] as const

const models = [
  { id: 'fable-5', name: 'Fable 5', icon: '/openlink/model.svg' },
  { id: 'fable-4', name: 'Fable 4', icon: '/openlink/model.svg' },
  { id: 'openlink-fast', name: 'OpenLink Fast', icon: '/openlink/model.svg' },
] as const

function UserAvatar({ avatarUrl, nickname, size = 22 }: { avatarUrl: string | null; nickname: string; size?: number }) {
  const initial = nickname.trim().charAt(0).toUpperCase() || 'O'

  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#7c3aed,#ec4899)] text-[10px] font-semibold text-white"
      style={{ width: size, height: size }}
    >
      {avatarUrl ? <img alt="" className="size-full object-cover" src={avatarUrl} /> : initial}
    </span>
  )
}

function SidebarItem({
  label,
  icon,
  active = false,
}: {
  label: string
  icon: string
  active?: boolean
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm tracking-[-0.1504px] transition-colors ${active ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]'}`}
      type="button"
    >
      <img alt="" className="app-nav-icon size-4 shrink-0" src={icon} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function Sidebar({
  collapsed,
  mobileOpen,
  onToggle,
  onCloseMobile,
  nickname,
  email,
  avatarUrl,
  themeMode,
  onThemeChange,
}: {
  collapsed: boolean
  mobileOpen: boolean
  onToggle: () => void
  onCloseMobile: () => void
  nickname: string
  email: string
  avatarUrl: string | null
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
}) {
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false)

  return (
    <>
      {mobileOpen && <button aria-label="关闭侧边栏" className="fixed inset-0 z-30 bg-black/70 md:hidden" onClick={onCloseMobile} type="button" />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[var(--app-sidebar-width)] shrink-0 flex-col overflow-visible border-r border-[var(--app-border)] bg-[var(--app-background)] transition-[transform,margin-left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:relative ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} ${collapsed ? 'md:-ml-[var(--app-sidebar-width)] md:translate-x-0 md:pointer-events-none' : 'md:ml-0 md:translate-x-0'}`}
      >
        <div className="flex flex-col gap-3 py-2">
          <div className="flex h-8 items-center gap-1 px-2">
            <button className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-transparent pl-1.5 hover:bg-[var(--app-surface)]" type="button">
              <UserAvatar avatarUrl={avatarUrl} nickname={nickname} />
              <span className="ml-1.5 min-w-0 flex-1 truncate text-left text-sm font-medium tracking-[-0.1504px] text-[var(--app-foreground)]">个人</span>
              <img alt="" className="app-control-icon mx-1 size-4" src="/openlink/app/scope-switcher.svg" />
            </button>
            <button aria-label="收起侧边栏" className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-surface)]" onClick={onToggle} type="button">
              <img alt="" className="app-control-icon size-4" src="/openlink/app/sidebar-toggle.svg" />
            </button>
          </div>

          <div className="px-2">
            <button className="flex h-8 w-full items-center justify-center rounded-md bg-[var(--app-surface)] pl-7 pr-2 text-sm font-medium tracking-[-0.1504px] text-[var(--app-foreground)]" type="button">
              <span className="flex-1">新建聊天</span><img alt="" className="app-control-icon size-4" src="/openlink/app/new-chat-chevron.svg" />
            </button>
          </div>

          <nav aria-label="工作区导航" className="flex flex-col gap-0.5 px-2">
            {primaryNavigation.map((item) => <SidebarItem key={item.label} {...item} />)}
          </nav>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <section>
            <div className="flex h-[30px] items-start justify-between px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)]">
              <span>收藏</span><img alt="" className="app-control-icon size-4 rotate-90" src="/openlink/app/section-chevron.svg" />
            </div>
            <SidebarItem icon="/openlink/app/chat.svg" label="AI Elements 集成" />
          </section>

          <section className="mt-5">
            <div className="flex h-[30px] items-start justify-between px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)]">
              <span>最近聊天</span><img alt="" className="app-control-icon size-4 rotate-90" src="/openlink/app/section-chevron.svg" />
            </div>
            <div className="flex flex-col gap-1.5">
              {recentChats.map((chat) => <SidebarItem icon="/openlink/app/chat.svg" key={chat} label={chat} />)}
            </div>
          </section>
        </div>

        <div className="flex h-12 shrink-0 items-end gap-1 px-2 pb-3">
          {accountDrawerOpen && (
            <AccountDrawer
              avatarUrl={avatarUrl}
              email={email}
              mode={themeMode}
              nickname={nickname}
              onModeChange={onThemeChange}
            />
          )}
          <button aria-expanded={accountDrawerOpen} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-0.5 hover:bg-[var(--app-surface)]" onClick={() => setAccountDrawerOpen((value) => !value)} title={email} type="button">
            <UserAvatar avatarUrl={avatarUrl} nickname={nickname} size={20} />
            <span className="min-w-0 flex-1 truncate text-left text-sm tracking-[-0.1504px] text-[var(--app-foreground)]">{email}</span>
          </button>
          <button className="flex h-9 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm font-medium text-[var(--app-foreground)]" type="button">$5</button>
        </div>
      </aside>
    </>
  )
}

function WorkspacePrompt({ initialPrompt }: { initialPrompt: string }) {
  const [input, setInput] = useState(initialPrompt)
  const [selectedModel, setSelectedModel] = useState(models[0])
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)

  return (
    <PromptInput
      className="w-full max-w-[690px] [&>[data-slot=input-group]]:h-[108px] [&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:border-[var(--app-prompt-border)] [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[var(--app-control-border)] [&>[data-slot=input-group]]:focus-within:ring-0"
      onSubmit={() => setInput('')}
    >
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="描述你想创建的内容"
          className="min-h-[54px]! px-3 pt-3 text-[15px] text-[var(--app-foreground)] placeholder:text-[var(--app-muted)]"
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder=""
          value={input}
        />
      </PromptInputBody>
      <PromptInputFooter className="h-10 px-3 pb-3">
        <PromptInputTools className="gap-0.5">
          <PromptInputButton aria-label="添加附件" className="size-7 rounded-md p-0 hover:bg-[var(--app-active)]" type="button">
            <img alt="" className="size-4" src="/openlink/app/plus.svg" />
          </PromptInputButton>
          <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
            <ModelSelectorTrigger
              render={
                <PromptInputButton className="h-7 max-w-[200px] gap-1 rounded-md px-1.5 text-[13px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button" />
              }
            >
              <img alt="" className="size-4" src={selectedModel.icon} />
              <span>{selectedModel.name}</span>
              <img alt="" className="app-control-icon size-4" src="/openlink/app/prompt-chevron.svg" />
            </ModelSelectorTrigger>
            <ModelSelectorContent className="w-[320px] border border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)]" title="选择模型">
              <ModelSelectorInput className="border-0 bg-transparent text-[var(--app-foreground)] placeholder:text-[var(--app-muted)]" placeholder="搜索模型" />
              <ModelSelectorList className="max-h-64 p-1">
                <ModelSelectorEmpty className="text-[var(--app-muted)]">没有找到模型</ModelSelectorEmpty>
                <ModelSelectorGroup heading="模型" className="[&_[cmdk-group-heading]]:text-[var(--app-muted)]">
                  {models.map((model) => (
                    <ModelSelectorItem
                      className="h-9 text-[var(--app-muted)] data-[selected=true]:bg-[var(--app-active)] data-[selected=true]:text-[var(--app-foreground)]"
                      key={model.id}
                      onSelect={() => {
                        setSelectedModel(model)
                        setModelSelectorOpen(false)
                      }}
                      value={model.name}
                    >
                      <img alt="" className="size-4" src={model.icon} />
                      <ModelSelectorName>{model.name}</ModelSelectorName>
                    </ModelSelectorItem>
                  ))}
                </ModelSelectorGroup>
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <PromptInputButton className="h-7 gap-1 rounded-lg px-2 text-[13px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button">
            <span>Project</span>
            <img alt="" className="app-control-icon size-3" src="/openlink/app/project-chevron.svg" />
          </PromptInputButton>
          <PromptInputSubmit aria-label="发送" className="size-7 rounded-md border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 hover:opacity-90">
            <img alt="" className="size-4" src="/openlink/app/mic.svg" />
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
  )
}

export function AppWorkspace({ workspaceName, nickname, email, avatarUrl, initialPrompt }: AppWorkspaceProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)

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
    <div className="openlink-app-shell flex h-dvh min-h-[500px] overflow-hidden" data-theme={activeTheme}>
      <Sidebar
        avatarUrl={avatarUrl}
        collapsed={collapsed}
        email={email}
        mobileOpen={mobileOpen}
        nickname={nickname}
        onThemeChange={handleThemeChange}
        onCloseMobile={() => setMobileOpen(false)}
        themeMode={themeMode}
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
          <span className="ml-2 truncate text-sm font-medium text-[var(--app-foreground)] md:hidden">{workspaceName}</span>
          {collapsed && (
            <button aria-label="展开侧边栏" className="hidden size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)] md:flex" onClick={() => setCollapsed(false)} type="button">
              <img alt="" className="app-control-icon size-4" src="/openlink/app/sidebar-expand.svg" />
            </button>
          )}
        </header>
        <div className="flex w-full justify-center">
          <WorkspacePrompt initialPrompt={initialPrompt} />
        </div>
      </main>
    </div>
  )
}
