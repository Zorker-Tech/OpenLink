'use client'

import { updateChatSessionTitleAction } from '@/app/chat/actions'
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
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input'
import { PromptAddMenu } from '@/components/prompt-add-menu'
import {
  BrowserWorkbench,
  type BrowserWorkbenchHandle,
  type BrowserWorkbenchUiState,
} from '@/components/browser/browser-workbench'
import { CodeServerWorkbench } from '@/components/code-server/code-server-workbench'
import { ProjectSupabasePanel } from '@/components/project-supabase-panel'
import { ProjectSupabaseStudioFrame } from '@/components/project-supabase-studio-frame'
import { Sidebar } from '@/components/app-workspace'
import type { ThemeMode } from '@/components/account-drawer'
import { ChatConfirmationDock, type ComposerConfirmationRequest } from '@/components/chat-confirmation-dock'
import { ChatTimeline, type ActiveFlowStatus } from '@/components/chat-timeline'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import { isOpenLinkAgentEvent, type OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import { hasPersistedUserMessage } from '@/lib/chat-auto-start'
import { theme } from '@/lib/theme'
import { useRouter } from 'next/navigation'
import { updateChatSessionSupabaseAccessModeAction } from '@/app/chat/actions'
import type { SupabaseAccessMode } from '@/lib/chat-sessions'
import { SupabaseAccessModePicker } from '@/components/supabase-access-mode-picker'
import { SupabasePendingWritesBanner } from '@/components/supabase-pending-writes-banner'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Code2,
  Database,
  Eye,
  ExternalLink,
  Globe2,
  Inspect,
  MessageCircle,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RotateCw,
  Send,
  Share2,
} from 'lucide-react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface GitVersionOption {
  ref: string
  shortRef: string
  message: string
  timestamp: string
  current: boolean
}

interface ChatWorkspaceProps {
  activeWorkspace: ActiveWorkspaceSummary
  personalWorkspace: PersonalWorkspaceSummary
  organizations: OrganizationSummary[]
  nickname: string
  email: string
  avatarUrl: string | null
  configuredModels: ConfiguredModelOption[]
  chatSessions: ChatSessionSummary[]
  autoStart: boolean
  autoStartModel: { providerId: string; modelId: string } | null
  initialEvents: OpenLinkAgentEvent[]
  initialPrompt: string
  sessionId: string
  sessionTitle: string
  projectName: string
  projectId: string
  userId: string
  localRuntime: boolean
  initialAccessMode?: SupabaseAccessMode
}

function pendingConfirmationRequests(events: OpenLinkAgentEvent[]) {
  const pending = new Map<string, ComposerConfirmationRequest>()
  for (const event of events) {
    if (event.type === 'confirmation.requested') {
      pending.set(event.confirmationId, {
        id: event.confirmationId,
        title: event.title,
        message: event.message,
        options: event.options,
        inputKind: event.inputKind,
      })
    }
    if (event.type === 'confirmation.resolved') pending.delete(event.confirmationId)
  }
  return [...pending.values()]
}

interface OptimisticUserMessage {
  id: string
  text: string
}

function mergeAgentEvents(
  current: OpenLinkAgentEvent[],
  incoming: OpenLinkAgentEvent[],
  optimisticUser?: OptimisticUserMessage,
) {
  if (!incoming.length) return current

  // Stream frames arrive in animation-frame batches. The old implementation
  // called `some()` and copied the whole array once per frame, which made a
  // long token/tool stream quadratic and was the source of the delayed chat
  // rendering seen after sending a message. Build one id set and one mutable
  // draft, then publish a single immutable array at the end.
  const next = current.slice()
  const ids = new Set(current.map((event) => event.id))
  let optimisticResolved = false
  let changed = false

  for (const event of incoming) {
    if (event.type === 'message.user' && optimisticUser && !optimisticResolved) {
      const optimisticIndex = next.findIndex((candidate) => candidate.id === optimisticUser.id)
      if (optimisticIndex >= 0) {
        next[optimisticIndex] = event
        ids.delete(optimisticUser.id)
        ids.add(event.id)
        optimisticResolved = true
        changed = true
        continue
      }
    }
    if (ids.has(event.id)) continue
    next.push(event)
    ids.add(event.id)
    changed = true
  }

  // Streams may replay an already-persisted event after a reconnect. Returning
  // the original state lets React bail out instead of scheduling a new render
  // for every replay frame.
  return changed ? next : current
}

function ToolbarButton({ label, children, className = '', ...props }: { label: string; children: React.ReactNode; className?: string } & React.ComponentProps<'button'>) {
  return (
    <button aria-label={label} className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)] disabled:pointer-events-none disabled:opacity-35 ${className}`} type="button" {...props}>
      {children}
    </button>
  )
}

function ChatTopbar({
  browserState,
  browserWorkbenchRef,
  collapsed,
  chatCollapsed,
  onOpenSidebar,
  onToggleChat,
  onToggleSidebar,
  onSelectBrowserSurface,
  onSelectCode,
  onSelectData,
  dataSurface,
  onToggleDataSurface,
  localRuntime,
  onToggleDeviceView,
  onSessionTitleChange,
  workspaceView,
  renameRequestVersion,
  sessionTitle,
  gitVersions = [],
  selectedGitRef,
  gitVersionsLoading = false,
  gitVersionError,
  onSelectGitVersion,
}: {
  browserState: BrowserWorkbenchUiState
  browserWorkbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  collapsed: boolean
  chatCollapsed: boolean
  onOpenSidebar: () => void
  onToggleChat: () => void
  onToggleSidebar: () => void
  onSelectBrowserSurface: (surface: 'native-preview' | 'chromium-stream') => void
  onSelectCode: () => void
  onSelectData: () => void
  dataSurface: 'panel' | 'studio'
  onToggleDataSurface: () => void
  localRuntime: boolean
  onToggleDeviceView: () => void
  onSessionTitleChange: (title: string) => Promise<boolean>
  workspaceView: 'mobile' | 'browser' | 'code' | 'data'
  renameRequestVersion: number
  sessionTitle: string
  gitVersions: GitVersionOption[]
  selectedGitRef: string | null
  gitVersionsLoading: boolean
  gitVersionError: string | null
  onSelectGitVersion: (ref: string | null) => void
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(sessionTitle)
  const [addressDraft, setAddressDraft] = useState(browserState.address)
  const [savingTitle, setSavingTitle] = useState(false)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const cancelTitleEditRef = useRef(false)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editingTitle) setTitleDraft(sessionTitle)
  }, [editingTitle, sessionTitle])

  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) setAddressDraft(browserState.address)
  }, [browserState.address])

  useEffect(() => {
    if (renameRequestVersion > 0) setEditingTitle(true)
  }, [renameRequestVersion])

  useEffect(() => {
    if (!editingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [editingTitle])

  const finishTitleEdit = async () => {
    if (cancelTitleEditRef.current) {
      cancelTitleEditRef.current = false
      setTitleDraft(sessionTitle)
      setEditingTitle(false)
      return
    }

    const nextTitle = titleDraft.trim().slice(0, 120)
    if (!nextTitle || nextTitle === sessionTitle) {
      setTitleDraft(sessionTitle)
      setEditingTitle(false)
      return
    }

    setSavingTitle(true)
    const saved = await onSessionTitleChange(nextTitle)
    if (!saved) setTitleDraft(sessionTitle)
    setSavingTitle(false)
    setEditingTitle(false)
  }

  return (
    <header className="flex h-[50px] shrink-0 items-center border-b border-[var(--app-border)] bg-[var(--app-background)] text-[var(--app-foreground)]">
      <div className="flex min-w-0 flex-1 items-center px-3 lg:w-[390px] lg:flex-none">
        <button aria-label="打开侧边栏" className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] md:hidden" onClick={onOpenSidebar} type="button">
          <PanelLeft className="size-4" />
        </button>
        {collapsed && <button aria-label="展开侧边栏" className="hidden size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] md:flex" onClick={onToggleSidebar} type="button"><PanelLeft className="size-4" /></button>}
        {editingTitle ? (
          <input
            aria-label="编辑项目名称"
            className="h-7 min-w-0 max-w-[220px] flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]"
            disabled={savingTitle}
            maxLength={120}
            onBlur={() => { void finishTitleEdit() }}
            onChange={(event) => setTitleDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                cancelTitleEditRef.current = true
                event.currentTarget.blur()
              }
            }}
            ref={titleInputRef}
            value={titleDraft}
          />
        ) : (
          <button aria-label="编辑项目名称" className="flex h-7 min-w-0 items-center rounded-md px-1 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" onClick={() => setEditingTitle(true)} type="button">
            <span className="max-w-[210px] truncate">{sessionTitle}</span>
          </button>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="hidden size-full items-center gap-1.5 pl-3 pr-1.5 xl:flex">
          <div className="flex h-7 w-7 shrink-0 items-center border-r border-[var(--app-border)]">
            <ToolbarButton aria-pressed={chatCollapsed} className={chatCollapsed ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''} label="评论" onClick={onToggleChat}><MessageCircle className="size-4" /></ToolbarButton>
          </div>
          <div className="flex h-[29px] w-[114px] shrink-0 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-px">
            <ToolbarButton aria-pressed={workspaceView === 'browser' && browserState.surface === 'native-preview'} className={`-ml-px mr-px size-[26px] ${workspaceView === 'browser' && browserState.surface === 'native-preview' ? 'bg-[var(--app-background)] text-[var(--app-foreground)]' : ''}`} label="预览" onClick={() => onSelectBrowserSurface('native-preview')}><Eye className="size-4" /></ToolbarButton>
            <ToolbarButton aria-pressed={workspaceView === 'browser' && browserState.surface === 'chromium-stream'} className={workspaceView === 'browser' && browserState.surface === 'chromium-stream' ? 'bg-[var(--app-background)] text-[var(--app-foreground)]' : ''} label="实时" onClick={() => onSelectBrowserSurface('chromium-stream')}><Send className="size-4" /></ToolbarButton>
            <ToolbarButton aria-pressed={workspaceView === 'code'} className={workspaceView === 'code' ? 'bg-[var(--app-background)] text-[var(--app-foreground)]' : ''} label="代码" onClick={onSelectCode}><Code2 className="size-4" /></ToolbarButton>
            <ToolbarButton aria-pressed={workspaceView === 'data'} className={workspaceView === 'data' ? 'bg-[var(--app-background)] text-[var(--app-foreground)]' : ''} label="数据" onClick={onSelectData}><Database className="size-4" /></ToolbarButton>
          </div>
          {workspaceView === 'data' && localRuntime && <button aria-pressed={dataSurface === 'studio'} className={`flex h-[26px] shrink-0 items-center gap-1 rounded-full border border-[var(--app-control-border)] px-2.5 text-xs font-medium transition-colors ${dataSurface === 'studio' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'bg-[var(--app-surface)] text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`} onClick={onToggleDataSurface} type="button"><ExternalLink className="size-3" />Studio</button>}
          <div className="flex min-w-[150px] flex-1 items-center justify-center">
            <form className={`relative -left-[3px] flex h-7 w-full max-w-[500px] items-center rounded-md border border-[var(--app-control-border)] px-0.5 ${workspaceView === 'code' || workspaceView === 'data' ? 'pointer-events-none opacity-0' : ''}`} onSubmit={(event) => { event.preventDefault(); browserWorkbenchRef.current?.navigate(addressDraft) }}>
              <ToolbarButton className="size-6!" disabled={!browserState.canGoBack} label="后退" onClick={() => browserWorkbenchRef.current?.back()}><ArrowLeft className="size-4" /></ToolbarButton>
              <ToolbarButton className="size-6!" disabled={!browserState.canGoForward} label="前进" onClick={() => browserWorkbenchRef.current?.forward()}><ArrowRight className="size-4" /></ToolbarButton>
              <ToolbarButton aria-pressed={workspaceView === 'mobile'} className="size-6! hover:bg-transparent!" disabled={workspaceView === 'code' || workspaceView === 'data'} label="设备" onClick={onToggleDeviceView}><img alt="" className="app-control-icon size-4" src="/openlink/app/phone.svg" /></ToolbarButton>
              <input
                aria-label="浏览器地址"
                className="h-6 min-w-0 flex-1 bg-transparent px-1 text-[12px] tracking-[-0.0762px] text-[var(--app-muted)] outline-none focus:text-[var(--app-foreground)]"
                onBlur={() => setAddressDraft(browserState.address)}
                onChange={(event) => setAddressDraft(event.currentTarget.value)}
                placeholder="输入网址或搜索"
                ref={addressInputRef}
                spellCheck={false}
                value={addressDraft}
              />
              <ToolbarButton aria-pressed={browserState.inspectMode} className={`size-6! ${browserState.inspectMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''}`} disabled={!browserState.canInspect} label="选择组件" onClick={() => browserWorkbenchRef.current?.toggleInspector()}><Inspect className="size-4" /></ToolbarButton>
              <ToolbarButton className="size-6!" disabled={!browserState.externalUrl} label="在新窗口打开" onClick={() => browserWorkbenchRef.current?.openExternal()}><ExternalLink className="size-4" /></ToolbarButton>
              <ToolbarButton className="size-6!" disabled={!browserState.canInspect} label="刷新" onClick={() => browserWorkbenchRef.current?.reload()}><RotateCw className="size-4" /></ToolbarButton>
              <ToolbarButton className="size-6!" label="更多预览选项"><ChevronDown className="size-4" /></ToolbarButton>
            </form>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<button aria-label="切换预览版本" className="flex h-7 w-[96px] shrink-0 items-center justify-center gap-1 rounded-md text-sm font-medium tracking-[-0.1504px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button" />}
            >
              <span className="max-w-[70px] truncate">{selectedGitRef ? `@${gitVersions.find((version) => version.ref === selectedGitRef)?.shortRef ?? selectedGitRef.slice(0, 8)}` : 'Latest'}</span>
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[280px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0">
              <DropdownMenuItem className="h-9 cursor-pointer gap-2 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]" disabled={!selectedGitRef} onClick={() => onSelectGitVersion(null)}>
                <span className="min-w-0 flex-1 truncate">Latest</span>
                {!selectedGitRef && <span className="text-[11px] text-[var(--app-muted)]">当前</span>}
              </DropdownMenuItem>
              {gitVersionsLoading && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">正在读取 Git 版本…</div>}
              {!gitVersionsLoading && gitVersions.length === 0 && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">暂无可切换的 Git 版本</div>}
              {!gitVersionsLoading && gitVersions.map((version) => (
                <DropdownMenuItem className="h-auto min-h-9 cursor-pointer gap-2 rounded-md px-2.5 py-1.5 text-sm focus:bg-[var(--app-hover)]" key={version.ref} onClick={() => onSelectGitVersion(version.ref)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{version.message}</span>
                    <span className="block text-[11px] text-[var(--app-muted)]">@{version.shortRef}{version.current ? ' · 当前提交' : ''}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              {gitVersionError && <div className="px-2.5 py-2 text-xs text-[var(--app-danger)]">{gitVersionError}</div>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex w-[150px] shrink-0 items-center gap-1.5 pr-3">
        <ToolbarButton className="border border-[var(--app-control-border)] bg-[var(--app-surface)]" label="更多"><MoreHorizontal className="size-4" /></ToolbarButton>
        <ToolbarButton className="border border-[var(--app-control-border)] bg-[var(--app-surface)]" label="分享"><Share2 className="size-4" /></ToolbarButton>
        <button className={`relative flex h-7 w-[70px] items-center justify-center gap-1.5 rounded-md border border-[var(--app-submit-background)] text-sm font-medium tracking-[-0.1504px] after:absolute after:-right-1 after:-top-1 after:size-3 after:rounded-full after:border-[1.5px] after:border-[var(--app-background)] after:bg-[var(--app-brand)] hover:opacity-90 ${theme('action')}`} type="button"><Globe2 className="size-4" />发布</button>
      </div>
    </header>
  )
}

function ChatComposer({
  initialModel,
  models,
  onSubmit,
  status,
  sessionId,
  accessMode,
  onAccessModeChange,
}: {
  initialModel: { providerId: string; modelId: string } | null
  models: ConfiguredModelOption[]
  onSubmit: (message: string, model: ConfiguredModelOption | null) => Promise<void> | void
  status: 'idle' | 'streaming'
  sessionId: string
  accessMode: SupabaseAccessMode
  onAccessModeChange: (mode: SupabaseAccessMode) => void
}) {
  const [input, setInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const availableModels = models
  const [selectedModelId, setSelectedModelId] = useState(() => availableModels.find((model) => (
    model.providerId === initialModel?.providerId && model.modelId === initialModel.modelId
  ))?.id ?? availableModels.find((model) => model.isDefault)?.id ?? availableModels[0]?.id ?? '')
  const selectedModel = availableModels.find((model) => model.id === selectedModelId) ?? availableModels[0] ?? null
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)

  const updateExpansion = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget
    if (!textarea.value) {
      setExpanded(false)
      return
    }
    if (expanded) return
    if (textarea.value.includes('\n') || textarea.scrollHeight > 20) setExpanded(true)
  }

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.currentTarget.value)
    updateExpansion(event)
  }

  useEffect(() => {
    if (input.length === 0) setExpanded(false)
  }, [input])

  const actionButtons = (
    <>
      <PromptAddMenu variant="session" />
      <PromptInputButton aria-label="添加评论" className="size-7 shrink-0 rounded-md p-0 transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:bg-[var(--app-active)]" type="button"><MessageCircle className="size-3.5" /></PromptInputButton>
      <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
        <ModelSelectorTrigger render={<PromptInputButton aria-label={`选择模型，当前 ${selectedModel?.name ?? '未配置'}`} className="h-7 w-12 shrink-0 gap-1 rounded-md px-1.5 text-[var(--app-muted)] transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)] aria-expanded:bg-transparent! aria-expanded:text-[var(--app-muted)]!" type="button" />}>
          <img alt="" className="size-4" src={selectedModel ? `https://models.dev/logos/${selectedModel.logo}.svg` : '/openlink/model.svg'} />
          <ChevronDown className="size-4" />
        </ModelSelectorTrigger>
        <ModelSelectorContent className="w-[280px]" title="选择模型">
          <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索模型" />
          <ModelSelectorList className="max-h-56 p-1">
            <ModelSelectorEmpty className="text-muted-foreground">没有找到模型</ModelSelectorEmpty>
            <ModelSelectorGroup heading="模型">
              {availableModels.map((model) => <ModelSelectorItem className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground" key={model.id} onSelect={() => { setSelectedModelId(model.id); setModelSelectorOpen(false) }} value={`${model.name} ${model.providerName}`}><img alt="" className="size-4" src={model.providerId ? `https://models.dev/logos/${model.logo}.svg` : '/openlink/model.svg'} /><ModelSelectorName>{model.name}</ModelSelectorName><span className="ml-auto text-[11px] text-muted-foreground">{model.providerName}</span></ModelSelectorItem>)}
            </ModelSelectorGroup>
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    </>
  )

  return (
    <div className="flex w-full flex-col gap-1.5">
      <SupabaseAccessModePicker value={accessMode} onChange={onAccessModeChange} className="self-start" />
    <PromptInput
      className={`w-full [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:transition-[padding,border-color] [&>[data-slot=input-group]]:duration-200 [&>[data-slot=input-group]]:focus-within:ring-0 ${expanded ? '[&>[data-slot=input-group]]:h-auto [&>[data-slot=input-group]]:max-h-[384px] [&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:flex-col [&>[data-slot=input-group]]:items-stretch [&>[data-slot=input-group]]:gap-0 [&>[data-slot=input-group]]:border-[var(--app-focus-ring)] [&>[data-slot=input-group]]:p-3' : '[&>[data-slot=input-group]]:h-[42px] [&>[data-slot=input-group]]:min-h-[42px] [&>[data-slot=input-group]]:gap-1 [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:p-1.5'}`}
      onSubmit={({ text }) => {
        if (!text.trim()) return
        void onSubmit(text.trim(), selectedModel)
        setInput('')
        setExpanded(false)
      }}
    >
      <div className={expanded ? 'flex min-h-[54px] max-h-[330px] w-full flex-col overflow-y-auto overscroll-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'contents'}>
        <PromptInputTextarea
          aria-label="描述你想创建的内容"
          className={expanded
            ? 'h-auto! min-h-0! max-h-none! w-full flex-none px-0 py-0 text-sm leading-5 text-[var(--app-foreground)] placeholder:text-[var(--app-muted)]'
            : 'h-5! min-h-5! max-h-5! flex-1 px-0 py-0 text-[13px] leading-5 text-[var(--app-foreground)] placeholder:text-[var(--app-muted)]'}
          onChange={handleChange}
          onInput={updateExpansion}
          placeholder=""
          value={input}
        />
      </div>
      <div className={expanded ? 'flex w-full shrink-0 items-end justify-between gap-1' : 'flex shrink-0 items-center gap-0.5'}>
        <div className={expanded ? 'flex min-w-0 flex-1 items-center gap-0.5' : 'contents'}>{actionButtons}</div>
        <PromptInputSubmit aria-label="发送" className="size-7 shrink-0 rounded-md border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 text-[var(--app-submit-foreground)] transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:opacity-90" disabled={status === 'streaming' || !selectedModel}><Send aria-hidden className="size-3.5" /></PromptInputSubmit>
      </div>
    </PromptInput>
    </div>
  )
}

function PreviewCanvas({
  browserWorkbenchRef,
  view,
  onBrowserStateChange,
  sessionId,
  projectName,
  panelProps,
  dataSurface,
}: {
  browserWorkbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  view: 'mobile' | 'browser' | 'code' | 'data'
  onBrowserStateChange: (state: BrowserWorkbenchUiState) => void
  sessionId: string
  projectName: string
  dataSurface: 'panel' | 'studio'
  panelProps: Pick<ChatWorkspaceProps, 'activeWorkspace' | 'avatarUrl' | 'chatSessions' | 'email' | 'nickname' | 'organizations' | 'personalWorkspace' | 'projectId' | 'userId'>
}) {
  if (view === 'code') return <CodeServerWorkbench chatSessionId={sessionId} />
  if (view === 'data') {
    if (dataSurface === 'studio') return <ProjectSupabaseStudioFrame sessionId={sessionId} />
    return <ProjectSupabasePanel {...panelProps} projectName={projectName} sessionId={sessionId} embedded />
  }
  const browserMode = view === 'browser'

  return (
    <main aria-label="预览画布" className={`relative size-full min-w-0 overflow-hidden ${browserMode ? theme('surface') : theme('editor')}`}>
      <div className={browserMode ? 'size-full' : 'flex size-full items-center justify-center px-4 py-[46px]'}>
        <div className={browserMode ? 'size-full' : `h-full max-h-[835px] w-[391px] max-w-full overflow-hidden rounded-xl border shadow-[0_8px_16px_-4px_var(--app-shadow),0_24px_32px_-8px_var(--app-shadow)] ${theme('surface', 'border')}`}>
          <BrowserWorkbench chatSessionId={sessionId} onStateChange={onBrowserStateChange} ref={browserWorkbenchRef} viewportMode={view} />
        </div>
      </div>
    </main>
  )
}

export function ChatWorkspace({
  activeWorkspace,
  personalWorkspace,
  organizations,
  nickname,
  email,
  avatarUrl,
  configuredModels,
  chatSessions,
  autoStart,
  autoStartModel,
  initialEvents,
  initialPrompt,
  sessionId,
  sessionTitle,
  projectName,
  projectId,
  userId,
  localRuntime,
  initialAccessMode = 'restricted',
}: ChatWorkspaceProps) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false)
  const [supabaseAccessMode, setSupabaseAccessMode] = useState<SupabaseAccessMode>(initialAccessMode)
  // The browser canvas is the primary workspace. The device control is an
  // explicit opt-in for the constrained mobile viewport.
  const [workspaceView, setWorkspaceView] = useState<'mobile' | 'browser' | 'code' | 'data'>('browser')
  // The data region hosts either the native project panel or a full-area
  // upstream Supabase Studio session; Local mode exposes the toggle capsule.
  const [dataSurface, setDataSurface] = useState<'panel' | 'studio'>('panel')
  const [browserState, setBrowserState] = useState<BrowserWorkbenchUiState>({
    browserSessionId: undefined,
    address: '',
    canGoBack: false,
    canGoForward: false,
    canInspect: false,
    inspectMode: false,
    status: 'connecting',
    surface: 'native-preview',
  })
  const [currentSessionTitle, setCurrentSessionTitle] = useState(sessionTitle)
  const [renameRequestVersion, setRenameRequestVersion] = useState(0)
  const [activeChatFlow, setActiveChatFlow] = useState<ActiveFlowStatus | null>(null)
  const [agentEvents, setAgentEvents] = useState<OpenLinkAgentEvent[]>(initialEvents)
  const [agentStreamStatus, setAgentStreamStatus] = useState<'idle' | 'streaming'>('idle')
  const streamQueueRef = useRef<OpenLinkAgentEvent[]>([])
  const streamFrameRef = useRef<number | null>(null)
  const activeRequestAbortRef = useRef<AbortController | null>(null)
  const pendingOptimisticUserRef = useRef<OptimisticUserMessage | null>(null)
  const nextClientSequenceRef = useRef(initialEvents.reduce((maximum, event) => Math.max(maximum, event.sequence), -1) + 1)
  const autoStartHandledRef = useRef(false)
  const chatPanelRef = useRef<PanelImperativeHandle | null>(null)
  const browserWorkbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const pendingConfirmations = useMemo(() => pendingConfirmationRequests(agentEvents), [agentEvents])
  const [gitVersions, setGitVersions] = useState<GitVersionOption[]>([])
  const [selectedGitRef, setSelectedGitRef] = useState<string | null>(null)
  const [gitVersionsLoading, setGitVersionsLoading] = useState(true)
  const [gitVersionError, setGitVersionError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setGitVersionsLoading(true)
    void fetch(`/api/chat/${encodeURIComponent(sessionId)}/git`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { versions?: unknown; error?: { message?: unknown } } | null
        if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : 'Git 版本读取失败')
        const versions = Array.isArray(payload?.versions) ? payload.versions.filter((value): value is GitVersionOption => {
          if (!value || typeof value !== 'object') return false
          const item = value as Record<string, unknown>
          return typeof item.ref === 'string' && typeof item.shortRef === 'string' && typeof item.message === 'string' && typeof item.timestamp === 'string' && typeof item.current === 'boolean'
        }) : []
        setGitVersions(versions)
        setGitVersionError(null)
      })
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setGitVersionError(error instanceof Error ? error.message : 'Git 版本读取失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setGitVersionsLoading(false)
      })
    return () => controller.abort()
  }, [sessionId])

  const appendAgentEvents = useCallback((incoming: OpenLinkAgentEvent[]) => {
    if (!incoming.length) return
    for (const event of incoming) {
      nextClientSequenceRef.current = Math.max(nextClientSequenceRef.current, event.sequence + 1)
    }
    const optimisticUser = incoming.some((event) => event.type === 'message.user')
      ? pendingOptimisticUserRef.current ?? undefined
      : undefined
    if (optimisticUser) pendingOptimisticUserRef.current = null
    setAgentEvents((current) => mergeAgentEvents(current, incoming, optimisticUser))
  }, [])

  const flushStreamQueue = useCallback(() => {
    streamFrameRef.current = null
    const queued = streamQueueRef.current.splice(0)
    appendAgentEvents(queued)
  }, [appendAgentEvents])

  const enqueueStreamEvent = useCallback((event: OpenLinkAgentEvent) => {
    nextClientSequenceRef.current = Math.max(nextClientSequenceRef.current, event.sequence + 1)
    streamQueueRef.current.push(event)
    if (streamFrameRef.current !== null) return
    streamFrameRef.current = window.requestAnimationFrame(flushStreamQueue)
  }, [flushStreamQueue])

  useEffect(() => () => {
    // Navigating away must cancel the upstream fetch as well as the local
    // animation queue. Without this, Next keeps the Agent Host request alive
    // until Pi finishes, holding the Cloud session lease and its sandbox even
    // though the chat page is gone.
    activeRequestAbortRef.current?.abort()
    activeRequestAbortRef.current = null
    if (streamFrameRef.current !== null) window.cancelAnimationFrame(streamFrameRef.current)
    streamFrameRef.current = null
    streamQueueRef.current = []
  }, [])

  useEffect(() => {
    // Browser Host binding is part of the Worker capability identity. Wait
    // until that binding is either connected or definitively unavailable so
    // opening a chat warms exactly the Worker that the first prompt will use,
    // instead of creating a no-browser Worker and immediately replacing it.
    if (browserState.status === 'connecting' || browserState.status === 'reconnecting') return
    let disposed = false
    const refreshLease = () => {
      void fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(autoStartModel ? { model: autoStartModel } : {}),
          ...(browserState.browserSessionId ? { browserSessionId: browserState.browserSessionId } : {}),
        }),
        cache: 'no-store',
      }).then((response) => {
        if (!response.ok && !disposed) console.warn(`OpenLink agent lease refresh failed (${response.status})`)
      }).catch(() => {
        // Lease refresh is best-effort. The next prompt can still rebuild the
        // sandbox from the durable PG Pi snapshot if the Agent Host is down.
      })
    }
    refreshLease()
    const timer = window.setInterval(refreshLease, 5 * 60_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [autoStartModel, browserState.browserSessionId, browserState.status, sessionId])

  const submitAgentMessage = useCallback(async (
    message: string,
    model: ConfiguredModelOption | null,
    options?: { initialPrompt?: boolean },
  ) => {
    if (agentStreamStatus === 'streaming') return
    setAgentStreamStatus('streaming')
    const optimisticUser: OptimisticUserMessage = {
      id: `${sessionId}:optimistic-user:${Date.now()}`,
      text: message,
    }
    appendAgentEvents([{
      version: 1,
      id: optimisticUser.id,
      sequence: nextClientSequenceRef.current++,
      sessionId,
      timestamp: new Date().toISOString(),
      source: 'pi',
      type: 'message.user',
      messageId: optimisticUser.id,
      text: message,
    }])
    // Set this after the local event is appended so the reconciliation token
    // remains reserved for the server's canonical message.user event.
    pendingOptimisticUserRef.current = optimisticUser

    const requestAbortController = new AbortController()
    activeRequestAbortRef.current = requestAbortController
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: requestAbortController.signal,
        body: JSON.stringify({
          message,
          ...(options?.initialPrompt ? { requestKind: 'initial-prompt' } : {}),
          ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
          ...((workspaceView === 'browser' || workspaceView === 'mobile') && browserState.browserSessionId ? { browserSessionId: browserState.browserSessionId } : {}),
        }),
      })
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string; detail?: string } | null
        if (options?.initialPrompt && response.status === 409 && failure?.error === 'SESSION_BUSY') {
          // Another mount/tab won the one-shot initial prompt race. Remove this
          // mount's optimistic copy; the winner's durable event is loaded by
          // the refresh and must remain the only user turn.
          if (pendingOptimisticUserRef.current?.id === optimisticUser.id) {
            pendingOptimisticUserRef.current = null
          }
          setAgentEvents((current) => current.filter((event) => event.id !== optimisticUser.id))
          router.refresh()
          return
        }
        const reason = failure?.detail || failure?.error || `Agent stream failed (${response.status})`
        throw new Error(reason === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED'
          ? '服务商密钥无法解密，请前往设置重新保存 API Key'
          : reason)
      }
      if (!response.body) throw new Error('Agent stream returned no response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            const event = JSON.parse(line) as unknown
            if (isOpenLinkAgentEvent(event)) enqueueStreamEvent(event)
          }
          newline = buffer.indexOf('\n')
        }
        if (done) break
      }
      if (buffer.trim()) throw new Error('Agent stream ended with an incomplete event')
    } catch (error) {
      if (requestAbortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
      const sequence = nextClientSequenceRef.current++
      appendAgentEvents([{
          version: 1,
          id: `${sessionId}:client-error:${sequence}`,
          sequence,
          sessionId,
          timestamp: new Date().toISOString(),
          source: 'pi',
          type: 'error',
          errorId: `${sessionId}:client-error:${sequence}`,
          message: error instanceof Error ? error.message : 'Agent stream failed',
          recoverable: true,
        }])
    } finally {
      if (activeRequestAbortRef.current === requestAbortController) activeRequestAbortRef.current = null
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current)
        streamFrameRef.current = null
      }
      appendAgentEvents(streamQueueRef.current.splice(0))
      setAgentStreamStatus('idle')
    }
  }, [agentStreamStatus, appendAgentEvents, browserState.browserSessionId, enqueueStreamEvent, router, sessionId, workspaceView])

  useEffect(() => {
    if (!autoStart || autoStartHandledRef.current || !initialPrompt.trim()) return
    if (hasPersistedUserMessage(agentEvents)) {
      autoStartHandledRef.current = true
      const url = new URL(window.location.href)
      url.searchParams.delete('run')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
      return
    }
    // An auto-start prompt must not outrun BrowserWorkbench provisioning. If
    // it did, Pi would be created without the scoped browser extension and a
    // browser-capable task would silently lose its tools. A failed browser
    // runtime is still allowed to proceed as a normal coding task.
    if (!browserState.browserSessionId && browserState.status !== 'failed') return
    autoStartHandledRef.current = true
    const url = new URL(window.location.href)
    url.searchParams.delete('run')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    const selectedModel = configuredModels.find((model) => (
      model.providerId === autoStartModel?.providerId && model.modelId === autoStartModel.modelId
    )) ?? null
    void submitAgentMessage(initialPrompt, selectedModel, { initialPrompt: true })
  }, [agentEvents, autoStart, autoStartModel, browserState.browserSessionId, browserState.status, configuredModels, initialPrompt, submitAgentMessage])

  const resolveConfirmation = useCallback(async (confirmationId: string, approved: boolean, value?: string) => {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/extension-ui-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: confirmationId,
        ...(value !== undefined ? { value } : { approved }),
      }),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof payload?.error === 'string' ? payload.error : '确认请求失败，请重试')
    }
  }, [sessionId])

  const updateSessionTitle = useCallback(async (title: string) => {
    const previousTitle = currentSessionTitle
    setCurrentSessionTitle(title)
    const result = await updateChatSessionTitleAction({ sessionId, title })
    if (result.error || !result.title) {
      setCurrentSessionTitle(previousTitle)
      return false
    }
    setCurrentSessionTitle(result.title)
    return true
  }, [currentSessionTitle, sessionId])

  const selectGitVersion = useCallback(async (ref: string | null) => {
    const previous = selectedGitRef
    setGitVersionError(null)
    if (!ref && !previous) {
      browserWorkbenchRef.current?.reload()
      return
    }
    setSelectedGitRef(ref)
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: ref ?? 'latest' }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as { version?: GitVersionOption; error?: { message?: unknown } } | null
      if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : 'Git 版本切换失败')
      if (payload?.version) setGitVersions((current) => current.map((version) => ({ ...version, current: version.ref === payload.version!.ref })))
      browserWorkbenchRef.current?.reload()
    } catch (error) {
      setSelectedGitRef(previous)
      setGitVersionError(error instanceof Error ? error.message : 'Git 版本切换失败')
    }
  }, [selectedGitRef, sessionId])

  const toggleChatPanel = () => {
    if (chatPanelCollapsed) {
      chatPanelRef.current?.expand()
      chatPanelRef.current?.resize('390px')
      setChatPanelCollapsed(false)
      return
    }
    chatPanelRef.current?.collapse()
    setChatPanelCollapsed(true)
  }

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme)
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updateSystemTheme = () => setSystemLight(media.matches)
    updateSystemTheme()
    media.addEventListener('change', updateSystemTheme)
    return () => media.removeEventListener('change', updateSystemTheme)
  }, [])

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
          activeChatId={sessionId}
          activeChatLabel={currentSessionTitle}
          activeChatRuntime={activeChatFlow ? { speed: 1, state: activeChatFlow.state } : { speed: 0.25, state: 'solving' }}
          activeWorkspace={activeWorkspace}
          avatarUrl={avatarUrl}
          chatSessions={chatSessions}
          collapsed={collapsed}
          email={email}
          mobileOpen={mobileOpen}
          nickname={nickname}
          onCloseMobile={() => setMobileOpen(false)}
          onNewChat={() => router.push(`/app/${activeWorkspace.slug}`)}
          onRenameActiveChat={() => setRenameRequestVersion((value) => value + 1)}
          onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }}
          onToggle={() => {
            if (mobileOpen) { setMobileOpen(false); setCollapsed(true) } else setCollapsed((value) => !value)
          }}
          organizations={organizations}
          personalWorkspace={personalWorkspace}
          themeMode={themeMode}
        />
        <div className="flex min-w-0 flex-1 flex-col bg-[var(--app-background)]">
          <ChatTopbar browserState={browserState} browserWorkbenchRef={browserWorkbenchRef} collapsed={collapsed} chatCollapsed={chatPanelCollapsed} dataSurface={dataSurface} gitVersionError={gitVersionError} gitVersions={gitVersions} gitVersionsLoading={gitVersionsLoading} localRuntime={localRuntime} onOpenSidebar={() => { setCollapsed(false); setMobileOpen(true) }} onSelectBrowserSurface={(surface) => { setWorkspaceView('browser'); browserWorkbenchRef.current?.setSurface(surface) }} onSelectCode={() => setWorkspaceView('code')} onToggleDataSurface={() => setDataSurface((surface) => surface === 'studio' ? 'panel' : 'studio')} onSelectData={() => setWorkspaceView('data')} onSelectGitVersion={selectGitVersion} onSessionTitleChange={updateSessionTitle} onToggleChat={toggleChatPanel} onToggleDeviceView={() => setWorkspaceView((view) => view === 'mobile' || view === 'data' ? 'browser' : 'mobile')} onToggleSidebar={() => setCollapsed(false)} renameRequestVersion={renameRequestVersion} selectedGitRef={selectedGitRef} sessionTitle={currentSessionTitle} workspaceView={workspaceView} />
          <div className="hidden min-h-0 flex-1 xl:flex">
            <ResizablePanelGroup className="min-h-0" id="chat-workspace-panels" orientation="horizontal">
              <ResizablePanel
                collapsedSize="0px"
                collapsible
                defaultSize="390px"
                groupResizeBehavior="preserve-pixel-size"
                id="chat-panel"
                maxSize="50%"
                minSize="390px"
                onResize={(size) => setChatPanelCollapsed((current) => current === (size.inPixels < 1) ? current : size.inPixels < 1)}
                panelRef={chatPanelRef}
              >
                <section className="flex size-full min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-background)]">
                  <ChatTimeline events={agentEvents} isStreaming={agentStreamStatus === 'streaming'} onFlowStatusChange={setActiveChatFlow} />
                  <div className="px-2 pb-2">
                    <ChatConfirmationDock onResolve={resolveConfirmation} requests={pendingConfirmations} />
                    <SupabasePendingWritesBanner sessionId={sessionId} />
                <ChatComposer accessMode={supabaseAccessMode} initialModel={autoStartModel} models={configuredModels} onAccessModeChange={(mode) => { setSupabaseAccessMode(mode); void updateChatSessionSupabaseAccessModeAction({ sessionId, mode }) }} onSubmit={submitAgentMessage} sessionId={sessionId} status={agentStreamStatus} />
                  </div>
                </section>
              </ResizablePanel>
              <ResizableHandle aria-label="调整聊天视图宽度" className="z-20 bg-[var(--app-border)]" id="chat-resize-handle" withHandle />
              <ResizablePanel className="min-w-0" groupResizeBehavior="preserve-relative-size" id="preview-panel" minSize="0px">
                <PreviewCanvas browserWorkbenchRef={browserWorkbenchRef} dataSurface={dataSurface} onBrowserStateChange={setBrowserState} panelProps={{ activeWorkspace, avatarUrl, chatSessions, email, nickname, organizations, personalWorkspace, projectId, userId }} projectName={projectName} sessionId={sessionId} view={workspaceView} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
          <div className="flex min-h-0 flex-1 xl:hidden">
            <section className="flex size-full min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-background)]">
              <ChatTimeline events={agentEvents} isStreaming={agentStreamStatus === 'streaming'} onFlowStatusChange={setActiveChatFlow} />
              <div className="px-2 pb-2">
                <ChatConfirmationDock onResolve={resolveConfirmation} requests={pendingConfirmations} />
                <ChatComposer accessMode={supabaseAccessMode} initialModel={autoStartModel} models={configuredModels} onAccessModeChange={(mode) => { setSupabaseAccessMode(mode); void updateChatSessionSupabaseAccessModeAction({ sessionId, mode }) }} onSubmit={submitAgentMessage} sessionId={sessionId} status={agentStreamStatus} />
              </div>
            </section>
          </div>
        </div>
      </div>
    </OpenLinkThemeProvider>
  )
}
