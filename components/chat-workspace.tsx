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
import {
  BrowserWorkbench,
  type BrowserWorkbenchHandle,
  type BrowserWorkbenchUiState,
} from '@/components/browser/browser-workbench'
import { Sidebar } from '@/components/app-workspace'
import type { ThemeMode } from '@/components/account-drawer'
import { ChatConfirmationDock, type ComposerConfirmationRequest } from '@/components/chat-confirmation-dock'
import { ChatTimeline, type ActiveFlowStatus } from '@/components/chat-timeline'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import { isOpenLinkAgentEvent, type OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import { useRouter } from 'next/navigation'
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
  let next = current
  let optimisticResolved = false

  for (const event of incoming) {
    if (event.type === 'message.user' && optimisticUser && !optimisticResolved) {
      const optimisticIndex = next.findIndex((candidate) => candidate.id === optimisticUser.id)
      if (optimisticIndex >= 0) {
        next = next.slice()
        next[optimisticIndex] = event
        optimisticResolved = true
        continue
      }
    }
    if (next.some((candidate) => candidate.id === event.id)) continue
    next = [...next, event]
  }

  return next
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
  onTogglePreview,
  onSessionTitleChange,
  previewMode,
  renameRequestVersion,
  sessionTitle,
}: {
  browserState: BrowserWorkbenchUiState
  browserWorkbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  collapsed: boolean
  chatCollapsed: boolean
  onOpenSidebar: () => void
  onToggleChat: () => void
  onToggleSidebar: () => void
  onTogglePreview: () => void
  onSessionTitleChange: (title: string) => Promise<boolean>
  previewMode: 'mobile' | 'browser'
  renameRequestVersion: number
  sessionTitle: string
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
            <ToolbarButton aria-pressed={browserState.surface === 'native-preview'} className={`-ml-px mr-px size-[26px] ${browserState.surface === 'native-preview' ? 'bg-[var(--app-background)] text-[var(--app-foreground)]' : ''}`} label="预览" onClick={() => browserWorkbenchRef.current?.setSurface('native-preview')}><Eye className="size-4" /></ToolbarButton>
            <ToolbarButton aria-pressed={browserState.surface === 'chromium-stream'} className={browserState.surface === 'chromium-stream' ? 'bg-[var(--app-background)] text-[var(--app-foreground)]' : ''} label="实时" onClick={() => browserWorkbenchRef.current?.setSurface('chromium-stream')}><Send className="size-4" /></ToolbarButton>
            <ToolbarButton label="代码"><Code2 className="size-4" /></ToolbarButton>
            <ToolbarButton label="数据"><Database className="size-4" /></ToolbarButton>
          </div>
          <div className="flex min-w-[150px] flex-1 items-center justify-center">
            <form className="relative -left-[3px] flex h-7 w-full max-w-[500px] items-center rounded-md border border-[var(--app-control-border)] px-0.5" onSubmit={(event) => { event.preventDefault(); browserWorkbenchRef.current?.navigate(addressDraft) }}>
              <ToolbarButton className="size-6!" disabled={!browserState.canGoBack} label="后退" onClick={() => browserWorkbenchRef.current?.back()}><ArrowLeft className="size-4" /></ToolbarButton>
              <ToolbarButton className="size-6!" disabled={!browserState.canGoForward} label="前进" onClick={() => browserWorkbenchRef.current?.forward()}><ArrowRight className="size-4" /></ToolbarButton>
              <ToolbarButton aria-pressed={previewMode === 'mobile'} className="size-6! hover:bg-transparent!" label="设备" onClick={onTogglePreview}><img alt="" className="app-control-icon size-4" src="/openlink/app/phone.svg" /></ToolbarButton>
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
          <button className="flex h-7 w-[76px] shrink-0 items-center justify-center gap-1 rounded-md text-sm font-medium tracking-[-0.1504px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button">Latest <ChevronDown className="size-4" /></button>
        </div>
      </div>

      <div className="flex w-[150px] shrink-0 items-center gap-1.5 pr-3">
        <ToolbarButton className="border border-[var(--app-control-border)] bg-[var(--app-surface)]" label="更多"><MoreHorizontal className="size-4" /></ToolbarButton>
        <ToolbarButton className="border border-[var(--app-control-border)] bg-[var(--app-surface)]" label="分享"><Share2 className="size-4" /></ToolbarButton>
        <button className="relative flex h-7 w-[70px] items-center justify-center gap-1.5 rounded-md border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] text-sm font-medium tracking-[-0.1504px] text-[var(--app-submit-foreground)] after:absolute after:-right-1 after:-top-1 after:size-3 after:rounded-full after:border-[1.5px] after:border-[var(--app-background)] after:bg-[#0070f3] hover:opacity-90" type="button"><Globe2 className="size-4" />发布</button>
      </div>
    </header>
  )
}

function ChatComposer({
  initialModel,
  models,
  onSubmit,
  status,
}: {
  initialModel: { providerId: string; modelId: string } | null
  models: ConfiguredModelOption[]
  onSubmit: (message: string, model: ConfiguredModelOption | null) => Promise<void> | void
  status: 'idle' | 'streaming'
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
      <PromptInputButton aria-label="添加附件" className="size-7 shrink-0 rounded-md p-0 transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:bg-[var(--app-active)]" type="button"><Plus className="size-4" /></PromptInputButton>
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
    <PromptInput
      className={`w-full [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:transition-[padding,border-color] [&>[data-slot=input-group]]:duration-200 [&>[data-slot=input-group]]:focus-within:ring-0 ${expanded ? '[&>[data-slot=input-group]]:h-auto [&>[data-slot=input-group]]:max-h-[384px] [&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:flex-col [&>[data-slot=input-group]]:items-stretch [&>[data-slot=input-group]]:gap-0 [&>[data-slot=input-group]]:border-[#454545] [&>[data-slot=input-group]]:p-3' : '[&>[data-slot=input-group]]:h-[42px] [&>[data-slot=input-group]]:min-h-[42px] [&>[data-slot=input-group]]:gap-1 [&>[data-slot=input-group]]:border-[#2e2e2e] [&>[data-slot=input-group]]:p-1.5'}`}
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
        <PromptInputSubmit aria-label="发送" className="size-7 shrink-0 rounded-md border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:opacity-90" disabled={status === 'streaming' || !selectedModel}><img alt="" className="app-submit-icon size-4" src="/openlink/app/mic.svg" /></PromptInputSubmit>
      </div>
    </PromptInput>
  )
}

function PreviewCanvas({
  browserWorkbenchRef,
  mode,
  onBrowserStateChange,
  sessionId,
}: {
  browserWorkbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  mode: 'mobile' | 'browser'
  onBrowserStateChange: (state: BrowserWorkbenchUiState) => void
  sessionId: string
}) {
  const browserMode = mode === 'browser'

  return (
    <main aria-label="预览画布" className={`relative size-full min-w-0 overflow-hidden ${browserMode ? 'bg-[#eee]' : 'bg-[#0a0a0a]'}`}>
      <div className={browserMode ? 'size-full' : 'flex size-full items-center justify-center px-4 py-[46px]'}>
        <div className={browserMode ? 'size-full' : 'h-full max-h-[835px] w-[391px] max-w-full overflow-hidden rounded-xl border border-[#292929] bg-[#eee] shadow-[0_8px_16px_-4px_rgb(0_0_0_/_4%),0_24px_32px_-8px_rgb(0_0_0_/_6%)]'}>
          <BrowserWorkbench chatSessionId={sessionId} onStateChange={onBrowserStateChange} ref={browserWorkbenchRef} viewportMode={mode} />
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
}: ChatWorkspaceProps) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false)
  const [previewMode, setPreviewMode] = useState<'mobile' | 'browser'>('mobile')
  const [browserState, setBrowserState] = useState<BrowserWorkbenchUiState>({
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
  const pendingOptimisticUserRef = useRef<OptimisticUserMessage | null>(null)
  const autoStartHandledRef = useRef(false)
  const chatPanelRef = useRef<PanelImperativeHandle | null>(null)
  const browserWorkbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const pendingConfirmations = useMemo(() => pendingConfirmationRequests(agentEvents), [agentEvents])

  const appendAgentEvents = useCallback((incoming: OpenLinkAgentEvent[]) => {
    if (!incoming.length) return
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
    streamQueueRef.current.push(event)
    if (streamFrameRef.current !== null) return
    streamFrameRef.current = window.requestAnimationFrame(flushStreamQueue)
  }, [flushStreamQueue])

  useEffect(() => () => {
    if (streamFrameRef.current !== null) window.cancelAnimationFrame(streamFrameRef.current)
    streamFrameRef.current = null
    streamQueueRef.current = []
  }, [])

  const submitAgentMessage = useCallback(async (message: string, model: ConfiguredModelOption | null) => {
    if (agentStreamStatus === 'streaming') return
    setAgentStreamStatus('streaming')
    const startSequence = (agentEvents.at(-1)?.sequence ?? -1) + 1
    const optimisticUser: OptimisticUserMessage = {
      id: `${sessionId}:optimistic-user:${Date.now()}`,
      text: message,
    }
    appendAgentEvents([{
      version: 1,
      id: optimisticUser.id,
      sequence: startSequence,
      sessionId,
      timestamp: new Date().toISOString(),
      source: agentEvents.at(-1)?.source ?? 'pi',
      type: 'message.user',
      messageId: optimisticUser.id,
      text: message,
    }])
    // Set this after the local event is appended so the reconciliation token
    // remains reserved for the server's canonical message.user event.
    pendingOptimisticUserRef.current = optimisticUser

    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, startSequence, ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}) }),
      })
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string; detail?: string } | null
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
    } catch (error) {
      const sequence = (agentEvents.at(-1)?.sequence ?? -1) + 1
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
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current)
        streamFrameRef.current = null
      }
      appendAgentEvents(streamQueueRef.current.splice(0))
      setAgentStreamStatus('idle')
    }
  }, [agentEvents, agentStreamStatus, appendAgentEvents, enqueueStreamEvent, sessionId])

  useEffect(() => {
    if (!autoStart || autoStartHandledRef.current || !initialPrompt.trim()) return
    autoStartHandledRef.current = true
    window.history.replaceState(window.history.state, '', window.location.pathname)
    const selectedModel = configuredModels.find((model) => (
      model.providerId === autoStartModel?.providerId && model.modelId === autoStartModel.modelId
    )) ?? null
    void submitAgentMessage(initialPrompt, selectedModel)
  }, [autoStart, autoStartModel, configuredModels, initialPrompt, submitAgentMessage])

  const resolveConfirmation = useCallback((confirmationId: string, approved: boolean, value?: string) => {
    setAgentEvents((current) => {
      const sequence = (current.at(-1)?.sequence ?? -1) + 1
      return [...current, {
        version: 1,
        id: `${sessionId}:confirmation:${sequence}`,
        sequence,
        sessionId,
        timestamp: new Date().toISOString(),
        source: current.at(-1)?.source ?? 'demo',
        type: 'confirmation.resolved',
        confirmationId,
        approved,
        value,
      }]
    })
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
          <ChatTopbar browserState={browserState} browserWorkbenchRef={browserWorkbenchRef} collapsed={collapsed} chatCollapsed={chatPanelCollapsed} onOpenSidebar={() => { setCollapsed(false); setMobileOpen(true) }} onSessionTitleChange={updateSessionTitle} onToggleChat={toggleChatPanel} onTogglePreview={() => setPreviewMode((mode) => mode === 'mobile' ? 'browser' : 'mobile')} onToggleSidebar={() => setCollapsed(false)} previewMode={previewMode} renameRequestVersion={renameRequestVersion} sessionTitle={currentSessionTitle} />
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
                    <ChatComposer initialModel={autoStartModel} models={configuredModels} onSubmit={submitAgentMessage} status={agentStreamStatus} />
                  </div>
                </section>
              </ResizablePanel>
              <ResizableHandle aria-label="调整聊天视图宽度" className="z-20 bg-[var(--app-border)]" id="chat-resize-handle" withHandle />
              <ResizablePanel className="min-w-0" groupResizeBehavior="preserve-relative-size" id="preview-panel" minSize="0px">
                <PreviewCanvas browserWorkbenchRef={browserWorkbenchRef} mode={previewMode} onBrowserStateChange={setBrowserState} sessionId={sessionId} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
          <div className="flex min-h-0 flex-1 xl:hidden">
            <section className="flex size-full min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-background)]">
              <ChatTimeline events={agentEvents} isStreaming={agentStreamStatus === 'streaming'} onFlowStatusChange={setActiveChatFlow} />
              <div className="px-2 pb-2">
                <ChatConfirmationDock onResolve={resolveConfirmation} requests={pendingConfirmations} />
                <ChatComposer initialModel={autoStartModel} models={configuredModels} onSubmit={submitAgentMessage} status={agentStreamStatus} />
              </div>
            </section>
          </div>
        </div>
      </div>
    </OpenLinkThemeProvider>
  )
}
