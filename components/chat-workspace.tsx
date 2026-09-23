'use client'

import { promptShouldExpand } from '@/lib/prompt-expansion'
import { PageTransition } from '@/components/ui/page-transition'
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed'

import { deleteChatSessionAction, updateChatSessionTitleAction } from '@/app/chat/actions'
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
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from '@/components/ai-elements/attachments'
import { AgentPromptTextarea, type AgentPromptSuggestion } from '@/components/agent-prompt-textarea'
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from '@/components/ai-elements/context'
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
import { isOpenLinkAgentEvent, type AgentPromptAttachment, type AgentPromptInstructionAttachment, type AgentPromptReferenceAttachment, type AgentPromptTextAttachment, type OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { serializePromptAttachments } from '@/lib/agent-runtime/serialize-prompt-attachments.client'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { createPastedTextAttachment, insertRestoredPastedText, PASTED_TEXT_ATTACHMENT_MAX_COUNT, pastedTextByteLength, shouldAttachPastedText } from '@/lib/agent-runtime/pasted-text'
import { recoverInterruptedInitialEvents } from '@/lib/agent-runtime/stream-integrity'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ClaimedChatPrompt, PromptModelSelection, QueuedChatPrompt } from '@/lib/chat-prompt-queue'
import type { ChatSessionSummary } from '@/lib/chat-session-types'
import type { CodexComposerResources, ComposerResources, RuntimeComposerResources, RuntimePromptResource } from '@/lib/composer-resources'
import { hasPersistedUserMessage } from '@/lib/chat-auto-start'
import { theme } from '@/lib/theme'
import { useRouter } from 'next/navigation'
import { updateChatSessionAccessModeAction } from '@/app/chat/actions'
import type { AccessMode } from '@/lib/chat-sessions'
import { transitionAccessMode } from '@/lib/access-mode-transition'
import { codexPluginToken } from '@/lib/prompt-input-protocol'
import { AccessWritesBanner } from '@/components/access-writes-banner'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronDown,
  Code2,
  Database,
  ExternalLink,
  FileText,
  Globe2,
  Inspect,
  MessageCircle,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RotateCw,
  Send,
  Square,
  Share2,
  X,
} from 'lucide-react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const CONTROL_ACTIONS_ALLOWED_DURING_TURN = new Set(['interrupt', 'pause', 'steer'])

interface GitVersionOption {
  ref: string
  shortRef: string
  message: string
  timestamp: string
  current: boolean
}

interface ChatContextStats {
  usage: {
    contextTokens: number | null
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens: number
    cachedInputTokens: number
  }
  contextWindow: number | null
  modelId: string | null
  providerId: string | null
}

// The vendored ai-elements Context component does not type-check against the
// installed `ai`/base-ui versions (pre-existing). It works at runtime, so we
// use a narrow cast for the props this header actually passes.
const ContextContainer = Context as unknown as React.FC<{
  usedTokens: number
  maxTokens: number
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens: number
    cachedInputTokens: number
    inputTokenDetails: Record<string, unknown>
    outputTokenDetails: Record<string, unknown>
  }
  modelId?: string
  className?: string
  children?: React.ReactNode
}>

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
  initialAccessMode?: AccessMode
  thinkingVisibility: 'summary' | 'hidden'
  composerResources: ComposerResources
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
        confirmationKind: event.confirmationKind,
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

/** Width of the inline session-title editor; the title slot animates to it. */
const TITLE_EDITOR_WIDTH = 220

type WorkspaceTabId = 'preview' | 'realtime' | 'code' | 'database'

type WorkspaceTabOption = { id: WorkspaceTabId; label: string; icon: typeof Globe2 }

function workspaceTabs(t: Translator): WorkspaceTabOption[] {
  return [
    { id: 'preview', label: t('预览'), icon: Globe2 },
    { id: 'realtime', label: t('实时浏览器'), icon: Send },
    { id: 'code', label: t('代码'), icon: Code2 },
    { id: 'database', label: t('数据库'), icon: Database },
  ]
}

function activeWorkspaceTab(workspaceView: 'mobile' | 'browser' | 'code' | 'data', surface: BrowserWorkbenchUiState['surface']): WorkspaceTabId {
  if (workspaceView === 'code') return 'code'
  if (workspaceView === 'data') return 'database'
  return surface === 'chromium-stream' ? 'realtime' : 'preview'
}

function WorkspaceTabLauncher({ onSelect }: { onSelect: (tab: WorkspaceTabId) => void }) {
  const t = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<ToolbarButton className="rounded-lg" label={t("打开新标签")}><Plus className="size-4" /></ToolbarButton>} />
      <DropdownMenuContent align="start" className="w-[216px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0">
        {workspaceTabs(t).map((tab) => {
          const Icon = tab.icon
          return <DropdownMenuItem className="h-8 cursor-pointer gap-3 rounded-md px-1.5 text-sm focus:bg-[var(--app-hover)]" key={tab.id} onClick={() => onSelect(tab.id)}><Icon className="size-4 text-[var(--app-muted)]" />{tab.label}</DropdownMenuItem>
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function WorkspaceTabs({
  activeTab,
  onClose,
  onSelect,
  openTabs,
}: {
  activeTab: WorkspaceTabId
  onClose: (tab: WorkspaceTabId) => void
  onSelect: (tab: WorkspaceTabId) => void
  openTabs: WorkspaceTabId[]
}) {
  const t = useT()
  const tabs = workspaceTabs(t)
  return (
    <div aria-label={t('工作区标签')} className="flex h-7 min-w-0 flex-1 items-center overflow-hidden">
      <div className="flex min-w-0 items-center overflow-x-auto pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <AnimatePresence initial={false} mode="popLayout">
          {openTabs.map((tabId) => {
            const tab = tabs.find((candidate) => candidate.id === tabId)!
            const Icon = tab.icon
            const selected = tabId === activeTab
            return (
            <motion.div
              animate={{ opacity: 1, scale: 1 }}
              className={`group mr-0.5 flex h-7 min-w-[112px] max-w-[126px] shrink-0 items-center rounded-lg transition-[background-color,color,box-shadow] duration-150 ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)] shadow-[inset_0_0_0_1px_var(--app-control-border),0_1px_2px_var(--app-shadow)]' : 'bg-[var(--app-surface)] text-[var(--app-muted)] shadow-[inset_0_0_0_1px_var(--app-control-border)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`}
              exit={{ opacity: 0, scale: 0.96 }}
              initial={{ opacity: 0, scale: 0.96 }}
              key={tabId}
              layout
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              <button
                aria-selected={selected}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2 text-[13px] font-medium tracking-[-0.0762px]"
                onClick={() => onSelect(tabId)}
                role="tab"
                type="button"
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
              <button
                aria-label={t('关闭{label}标签', { label: tab.label })}
                className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded text-[var(--app-subtle)] transition-[color,background-color,opacity] hover:bg-[var(--app-control-border)] hover:text-[var(--app-foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)] ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
                onClick={() => onClose(tabId)}
                type="button"
              >
                <X aria-hidden className="size-3" />
              </button>
            </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}

function ChatTopbar({
  collapsed,
  chatCollapsed,
  onOpenSidebar,
  onToggleChat,
  onToggleSidebar,
  dataSurface,
  onToggleDataSurface,
  localRuntime,
  onSessionTitleChange,
  workspaceView,
  renameRequestVersion,
  sessionTitle,
  context,
  side,
  activeTab,
  onCloseWorkspaceTab,
  onSelectWorkspaceTab,
  openTabs,
  showWorkspaceLauncher = false,
}: {
  collapsed: boolean
  chatCollapsed: boolean
  onOpenSidebar: () => void
  onToggleChat: () => void
  onToggleSidebar: () => void
  dataSurface: 'panel' | 'studio'
  onToggleDataSurface: () => void
  localRuntime: boolean
  onSessionTitleChange: (title: string) => Promise<boolean>
  workspaceView: 'mobile' | 'browser' | 'code' | 'data'
  renameRequestVersion: number
  sessionTitle: string
  context: ChatContextStats | null
  side: 'chat' | 'workspace'
  activeTab: WorkspaceTabId
  onCloseWorkspaceTab: (tab: WorkspaceTabId) => void
  onSelectWorkspaceTab: (tab: WorkspaceTabId) => void
  openTabs: WorkspaceTabId[]
  showWorkspaceLauncher?: boolean
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(sessionTitle)
  const [savingTitle, setSavingTitle] = useState(false)
  const [titleWidth, setTitleWidth] = useState<number | null>(null)
  const cancelTitleEditRef = useRef(false)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const titleMeasureRef = useRef<HTMLSpanElement | null>(null)
  const t = useT()

  // The title slot animates between the measured text width and the editor
  // width. Measuring keeps the resting state hugging the text instead of
  // reserving a fixed slot, while the transition itself is a real width change
  // so the surrounding header controls glide along with it.
  useEffect(() => {
    const element = titleMeasureRef.current
    if (!element) return
    const update = () => setTitleWidth(element.offsetWidth)
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [sessionTitle])

  useEffect(() => {
    if (!editingTitle) setTitleDraft(sessionTitle)
  }, [editingTitle, sessionTitle])

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
    <header className="flex h-[50px] shrink-0 items-center overflow-hidden border-b border-[var(--app-border)] bg-[var(--app-background)] text-[var(--app-foreground)]">
      {side === 'chat' && (
      <motion.div
        animate={{ opacity: chatCollapsed ? 0 : 1, x: chatCollapsed ? -10 : 0 }}
        aria-hidden={chatCollapsed}
        className="flex size-full min-w-0 items-center px-3"
        data-header-region="chat-title"
        initial={false}
        style={{ pointerEvents: chatCollapsed ? 'none' : 'auto' }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <button aria-label={t('打开侧边栏')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] md:hidden" onClick={onOpenSidebar} type="button">
          <PanelLeft className="size-4" />
        </button>
        {collapsed && <button aria-label={t('展开侧边栏')} className="hidden size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] md:flex" onClick={onToggleSidebar} type="button"><PanelLeft className="size-4" /></button>}
        {context && (() => {
          const contextUsage = {
            ...context.usage,
            inputTokenDetails: {
              noCacheTokens: Math.max(context.usage.inputTokens - context.usage.cachedInputTokens, 0),
              cacheReadTokens: context.usage.cachedInputTokens,
              cacheWriteTokens: 0,
            },
            outputTokenDetails: {
              textTokens: Math.max(context.usage.outputTokens - context.usage.reasoningTokens, 0),
              reasoningTokens: context.usage.reasoningTokens,
            },
          }
          const contextTokens = context.usage.contextTokens
          const contextWindow = contextTokens == null ? null : context.contextWindow
          const usedCompact = contextTokens == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact' }).format(contextTokens)
          return (
            <span className="mr-1 flex shrink-0">
              <ContextContainer
                maxTokens={contextWindow ?? Math.max(contextTokens ?? 0, 1)}
                modelId={context.modelId ?? undefined}
                usage={contextUsage}
                usedTokens={contextTokens ?? 0}
              >
                {contextWindow
                  ? (
                    <ContextTrigger className="h-7 shrink-0 gap-1.5 rounded-md px-1.5 text-xs text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" />
                  )
                  : (
                    <ContextTrigger>
                      <span className="flex h-7 shrink-0 items-center rounded-md px-1.5 text-xs font-medium tabular-nums text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" title={t('最近一次模型上下文用量；未上报时显示未知')}>
                        {usedCompact}
                      </span>
                    </ContextTrigger>
                  )}
                <ContextContent>
                  {contextWindow
                    ? <ContextContentHeader />
                    : (
                      <ContextContentHeader>
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <p className="font-medium tabular-nums">{usedCompact} tokens</p>
                          <p className="text-[var(--app-subtle)]">{contextTokens == null ? t('尚无原生上下文统计') : t('上下文上限未知')}</p>
                        </div>
                      </ContextContentHeader>
                    )}
                  <p className="px-3 pt-2 text-xs text-[var(--app-muted)]">{t('以下为会话累计消耗，不是上下文占用')}</p>
                  <ContextInputUsage className="px-3 py-2.5" />
                  <ContextOutputUsage className="px-3 py-2.5" />
                  <ContextCacheUsage className="px-3 py-2.5" />
                  <ContextReasoningUsage className="px-3 py-2.5" />
                </ContextContent>
              </ContextContainer>
            </span>
          )
        })()}
        <div className="relative flex h-7 min-w-0 items-center">
          {/* Off-screen probe: the slot animates between the real text width and
              the editor width, so neighbouring chrome slides with it instead of
              jumping the way a transform-based layout animation does. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-[9999px] top-0 max-w-[210px] truncate text-[13px] font-medium tracking-[-0.0762px] opacity-0"
            ref={titleMeasureRef}
          >
            {sessionTitle}
          </span>
          <motion.div
            animate={{ width: editingTitle ? TITLE_EDITOR_WIDTH : (titleWidth ?? undefined) }}
            className="flex h-7 min-w-0 items-center overflow-hidden"
            initial={false}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            {editingTitle ? (
              <input
                aria-label={t('编辑项目名称')}
                className="h-7 w-full min-w-0 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]"
                data-no-press-motion
                disabled={savingTitle}
                key="title-editor"
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
              <button
                aria-label={t('编辑项目名称')}
                className="flex h-7 w-full min-w-0 items-center rounded-md px-1 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]"
                data-no-press-motion
                key="title-display"
                onClick={() => setEditingTitle(true)}
                type="button"
              >
                <span className="max-w-[210px] truncate">{sessionTitle}</span>
              </button>
            )}
          </motion.div>
        </div>
        {showWorkspaceLauncher && <div className="ml-auto"><WorkspaceTabLauncher onSelect={onSelectWorkspaceTab} /></div>}
      </motion.div>
      )}

      {side === 'workspace' && (
      <div className="flex min-w-0 flex-1 items-center" data-header-region="workspace-tabs">
        <div className="flex size-full min-w-0 items-center gap-1.5 pl-3 pr-1.5">
          {chatCollapsed && collapsed && <ToolbarButton label={t('展开侧边栏')} onClick={onToggleSidebar}><PanelLeft className="size-4" /></ToolbarButton>}
          <ToolbarButton aria-pressed={chatCollapsed} className={chatCollapsed ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''} label={t('评论')} onClick={onToggleChat}><MessageCircle className="size-4" /></ToolbarButton>
          <WorkspaceTabs activeTab={activeTab} onClose={onCloseWorkspaceTab} onSelect={onSelectWorkspaceTab} openTabs={openTabs} />
          <WorkspaceTabLauncher onSelect={onSelectWorkspaceTab} />
          {workspaceView === 'data' && localRuntime && <button aria-pressed={dataSurface === 'studio'} className={`flex h-[26px] shrink-0 items-center gap-1 rounded-full border border-[var(--app-control-border)] px-2.5 text-xs font-medium transition-colors ${dataSurface === 'studio' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'bg-[var(--app-surface)] text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`} onClick={onToggleDataSurface} type="button"><ExternalLink className="size-3" />Studio</button>}
        </div>
      </div>
      )}
      {side === 'workspace' && (
      <div className="flex w-[150px] shrink-0 items-center gap-1.5 pr-3">
        <ToolbarButton className="border border-[var(--app-control-border)] bg-[var(--app-surface)]" label={t("更多")}><MoreHorizontal className="size-4" /></ToolbarButton>
        <ToolbarButton className="border border-[var(--app-control-border)] bg-[var(--app-surface)]" label={t("分享")}><Share2 className="size-4" /></ToolbarButton>
        <button className={`relative flex h-7 w-[70px] items-center justify-center gap-1.5 rounded-md border border-[var(--app-submit-background)] text-sm font-medium tracking-[-0.1504px] after:absolute after:-right-1 after:-top-1 after:size-3 after:rounded-full after:border-[1.5px] after:border-[var(--app-background)] after:bg-[var(--app-brand)] hover:opacity-90 ${theme('action')}`} type="button"><Globe2 className="size-4" />{t('发布')}</button>
      </div>
      )}
    </header>
  )
}

function BrowserNavigationBar({
  browserState,
  browserWorkbenchRef,
  gitVersions,
  gitVersionsLoading,
  gitVersionError,
  onSelectGitVersion,
  onToggleDeviceView,
  selectedGitRef,
  workspaceView,
}: {
  browserState: BrowserWorkbenchUiState
  browserWorkbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  gitVersions: GitVersionOption[]
  gitVersionsLoading: boolean
  gitVersionError: string | null
  onSelectGitVersion: (ref: string | null) => void
  onToggleDeviceView: () => void
  selectedGitRef: string | null
  workspaceView: 'mobile' | 'browser'
}) {
  const [addressDraft, setAddressDraft] = useState(browserState.address)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const t = useT()

  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) setAddressDraft(browserState.address)
  }, [browserState.address])

  return (
    <div aria-label={t('浏览器工具栏')} className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--app-border)] bg-[var(--app-background)] p-2 text-[var(--app-foreground)]">
      <div aria-hidden className="size-7 shrink-0" />
      <div className="flex min-w-[150px] flex-1 items-center justify-center">
        <form className="flex h-7 w-full max-w-[500px] items-center overflow-hidden rounded-md border border-[var(--app-control-border)] px-0.5" onSubmit={(event) => { event.preventDefault(); browserWorkbenchRef.current?.navigate(addressDraft) }}>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.canGoBack} label={t("后退")} onClick={() => browserWorkbenchRef.current?.back()}><ArrowLeft className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.canGoForward} label={t("前进")} onClick={() => browserWorkbenchRef.current?.forward()}><ArrowRight className="size-4" /></ToolbarButton>
          <ToolbarButton aria-pressed={workspaceView === 'mobile'} className="size-6! rounded hover:bg-transparent!" label={t("设备")} onClick={onToggleDeviceView}><img alt="" className="app-control-icon size-4" src="/openlink/app/phone.svg" /></ToolbarButton>
          <input
            aria-label={t('浏览器地址')}
            className="h-6 min-w-0 flex-1 bg-transparent px-1 text-[12px] tracking-[-0.0762px] text-[var(--app-muted)] outline-none focus:text-[var(--app-foreground)]"
            onBlur={() => setAddressDraft(browserState.address)}
            onChange={(event) => setAddressDraft(event.currentTarget.value)}
            placeholder={t('输入网址或搜索')}
            ref={addressInputRef}
            spellCheck={false}
            value={addressDraft}
          />
          <ToolbarButton aria-pressed={browserState.inspectMode} className={`size-6! rounded ${browserState.inspectMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''}`} disabled={!browserState.canInspect} label={t('选择组件')} onClick={() => browserWorkbenchRef.current?.toggleInspector()}><Inspect className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.externalUrl} label={t("在新窗口打开")} onClick={() => browserWorkbenchRef.current?.openExternal()}><ExternalLink className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" disabled={!browserState.canInspect} label={t("刷新")} onClick={() => browserWorkbenchRef.current?.reload()}><RotateCw className="size-4" /></ToolbarButton>
          <ToolbarButton className="size-6! rounded" label={t("更多预览选项")}><ChevronDown className="size-4" /></ToolbarButton>
        </form>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<button aria-label={t('切换预览版本')} className="flex h-7 w-[96px] shrink-0 items-center justify-center gap-1 rounded-md text-sm font-medium tracking-[-0.1504px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" type="button" />}>
          <span className="max-w-[70px] truncate">{selectedGitRef ? `@${gitVersions.find((version) => version.ref === selectedGitRef)?.shortRef ?? selectedGitRef.slice(0, 8)}` : 'Latest'}</span>
          <ChevronDown className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[280px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0">
          <DropdownMenuItem className="h-9 cursor-pointer gap-2 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]" disabled={!selectedGitRef} onClick={() => onSelectGitVersion(null)}>
            <span className="min-w-0 flex-1 truncate">Latest</span>
            {!selectedGitRef && <span className="text-[11px] text-[var(--app-muted)]">{t('当前')}</span>}
          </DropdownMenuItem>
          {gitVersionsLoading && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">{t('正在读取 Git 版本…')}</div>}
          {!gitVersionsLoading && gitVersions.length === 0 && <div className="px-2.5 py-2 text-xs text-[var(--app-muted)]">{t('暂无可切换的 Git 版本')}</div>}
          {!gitVersionsLoading && gitVersions.map((version) => (
            <DropdownMenuItem className="h-auto min-h-9 cursor-pointer gap-2 rounded-md px-2.5 py-1.5 text-sm focus:bg-[var(--app-hover)]" key={version.ref} onClick={() => onSelectGitVersion(version.ref)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{version.message}</span>
                <span className="block text-[11px] text-[var(--app-muted)]">@{version.shortRef}{version.current ? t(' · 当前提交') : ''}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {gitVersionError && <div className="px-2.5 py-2 text-xs text-[var(--app-danger)]">{gitVersionError}</div>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ComposerAttachments() {
  const attachments = usePromptInputAttachments()
  const t = useT()
  if (!attachments.files.length) return null
  return <Attachments className="w-full px-1 pt-1" variant="inline">
    {attachments.files.map((file) => <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
      <AttachmentPreview />
      <AttachmentInfo />
      <AttachmentRemove label={t('移除 {name}', { name: file.filename ?? t('图片') })} />
    </Attachment>)}
  </Attachments>
}

function ComposerSubmitButton({ status, input, disabled, hasStructuredAttachments, onStop }: { status: 'idle' | 'streaming'; input: string; disabled: boolean; hasStructuredAttachments: boolean; onStop: () => void }) {
  const attachments = usePromptInputAttachments()
  const t = useT()
  const hasDraft = Boolean(input.trim() || attachments.files.length || hasStructuredAttachments)
  const stopping = status === 'streaming' && !hasDraft
  return <PromptInputSubmit
    aria-label={status === 'streaming' ? hasDraft ? t('加入队列') : t('停止') : t('发送')}
    className="size-7 shrink-0 rounded-md border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 text-[var(--app-submit-foreground)] transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:opacity-90"
    disabled={disabled}
    onMouseDown={(event) => { if (stopping) event.preventDefault() }}
    onClick={(event) => { if (stopping) { event.preventDefault(); onStop() } }}
    type={stopping ? 'button' : 'submit'}
  >{stopping ? <Square aria-hidden className="size-3 fill-current" /> : <Send aria-hidden className="size-3.5" />}</PromptInputSubmit>
}

export function ChatComposer({
  initialModel,
  models,
  onSubmit,
  onRename,
  onFork,
  status,
  sessionId,
  context,
  accessMode,
  onAccessModeChange,
  composerResources,
  runtimeResources,
  codexResources,
  onInstallPlugin,
  onInterrupt,
}: {
  initialModel: { providerId: string; modelId: string } | null
  models: ConfiguredModelOption[]
  onSubmit: (message: string, model: PromptModelSelection | null, options?: { attachments?: AgentPromptAttachment[]; onAccepted?: () => void }) => Promise<boolean>
  onRename: () => void
  onFork: (path: string) => void
  status: 'idle' | 'streaming'
  sessionId: string
  context: ChatContextStats | null
  accessMode: AccessMode
  onAccessModeChange: (mode: AccessMode) => Promise<boolean>
  composerResources: ComposerResources
  runtimeResources: RuntimeComposerResources | null
  codexResources: CodexComposerResources | null
  onInstallPlugin: (pluginId: string) => Promise<void>
  onInterrupt: () => void
}) {
  const t = useT()
  const [input, setInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [controlPending, setControlPending] = useState(false)
  const [controlReady, setControlReady] = useState(false)
  const [runtimeBusy, setRuntimeBusy] = useState<boolean | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [sessionPaused, setSessionPaused] = useState(false)
  const [sessionMode, setSessionMode] = useState('default')
  const [goalObjective, setGoalObjective] = useState<string | null>(null)
  const [goalStatus, setGoalStatus] = useState<string | null>(null)
  const [goalTokens, setGoalTokens] = useState<number | null>(null)
  const [goalEditorOpen, setGoalEditorOpen] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')
  const [statusPanelOpen, setStatusPanelOpen] = useState(false)
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedChatPrompt[]>([])
  const [pastedTextAttachments, setPastedTextAttachments] = useState<Array<AgentPromptTextAttachment & { id: string }>>([])
  const [referenceAttachments, setReferenceAttachments] = useState<Array<AgentPromptReferenceAttachment & { id: string }>>([])
  const [instructionAttachments, setInstructionAttachments] = useState<Array<AgentPromptInstructionAttachment & { id: string }>>([])
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const forceSteerRef = useRef(false)
  const queueDrainRef = useRef(false)
  const runAccessModeChange = useCallback(async (mode: AccessMode) => {
    if (mode === accessMode) return true
    if (status === 'streaming') {
      setControlError(t('请等待当前回复结束后再切换权限'))
      return false
    }
    setControlPending(true)
    setControlError(null)
    try {
      const changed = await onAccessModeChange(mode)
      if (!changed) {
        setControlError(t('权限切换未生效，已恢复原权限'))
        return false
      }
      return true
    } catch {
      setControlError(t('权限切换未生效，已恢复原权限'))
      return false
    } finally {
      setControlPending(false)
    }
  }, [accessMode, onAccessModeChange, status])
  const runPluginInstall = useCallback(async (pluginId: string) => {
    if (status === 'streaming') throw new Error(t('请等待当前回复结束后再安装插件'))
    setControlPending(true)
    setControlError(null)
    try {
      await onInstallPlugin(pluginId)
    } finally {
      setControlPending(false)
    }
  }, [onInstallPlugin, status])
  const refreshQueue = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error(t('消息队列读取失败'))
    const payload = await response.json() as { items?: QueuedChatPrompt[] }
    setQueuedFollowUps(Array.isArray(payload.items) ? payload.items : [])
  }, [sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void refreshQueue(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setControlError(error instanceof Error ? error.message : t('消息队列读取失败'))
    })
    const refresh = () => { if (document.visibilityState === 'visible') void refreshQueue(controller.signal).catch(() => {}) }
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 5_000)
    return () => { controller.abort(); document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer) }
  }, [refreshQueue])

  const enqueueFollowUp = useCallback(async (text: string, attachments: AgentPromptAttachment[], model: PromptModelSelection | null) => {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), message: text, attachments, model }),
    })
    const payload = await response.json().catch(() => null) as { item?: QueuedChatPrompt; error?: string } | null
    if (!response.ok || !payload?.item) throw new Error(payload?.error ?? t('消息加入队列失败'))
    setQueuedFollowUps((current) => current.some((item) => item.id === payload.item!.id) ? current : [...current, payload.item!])
  }, [sessionId])

  const deleteQueuedFollowUps = useCallback(async (id?: string) => {
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(t('消息队列删除失败'))
    await refreshQueue()
  }, [refreshQueue, sessionId])
  const runControl = useCallback(async (action: string, text?: string) => {
    if (action !== 'status') { setControlPending(true); setControlError(null) }
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/control`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, text }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error ?? t('Agent 控制失败'))
      if (action === 'status') {
        setControlReady(true)
        setRuntimeBusy(typeof payload?.result?.busy === 'boolean' ? payload.result.busy : null)
      }
      if (typeof payload?.paused === 'boolean') setSessionPaused(payload.paused)
      if (payload?.result?.mode) setSessionMode(payload.result.mode)
      const goal = payload?.result?.goal?.goal ?? payload?.result?.goal
      if (goal && typeof goal.objective === 'string') {
        setGoalObjective(goal.objective)
        setGoalStatus(typeof goal.status === 'string' ? goal.status : null)
        setGoalTokens(typeof goal.tokensUsed === 'number' ? goal.tokensUsed : null)
      }
      if (action === 'goal-clear') setGoalObjective(null)
      if (action === 'compact' && payload?.result?.compacted !== false) window.dispatchEvent(new CustomEvent('openlink:context-invalidated', { detail: { sessionId } }))
      if (action === 'fork' && typeof payload?.fork?.path === 'string') onFork(payload.fork.path)
      return true
    } catch (error) {
      if (action === 'status') { setControlReady(false); setRuntimeBusy(null) }
      if (action !== 'status') setControlError(error instanceof Error ? error.message : t('Agent 控制失败'))
      return false
    } finally { if (action !== 'status') setControlPending(false) }
  }, [onFork, sessionId])
  useEffect(() => {
    if (!runtimeResources?.agent) return
    void runControl('status')
    // Refresh only after a runtime/turn boundary, not every streamed token.
  }, [sessionId, runtimeResources?.agent, status, runControl])
  useEffect(() => {
    if (runtimeBusy !== true) return
    const timer = window.setInterval(() => { void runControl('status') }, 1_500)
    return () => window.clearInterval(timer)
  }, [runControl, runtimeBusy])
  const availableModels = models
  const [selectedModelId, setSelectedModelId] = useState(() => {
    // Prefer the session's stored model so a chat reopens on the model it was
    // created with. Match by provider+model, then fall back to a modelId-only
    // match (for catalog mismatches), then the default, then the first entry.
    const exact = availableModels.find((model) => (
      model.providerId === initialModel?.providerId && model.modelId === initialModel.modelId
    ))
    if (exact) return exact.id
    const byModelId = initialModel?.modelId
      ? availableModels.find((model) => model.modelId === initialModel.modelId)
      : undefined
    return byModelId?.id ?? availableModels.find((model) => model.isDefault)?.id ?? availableModels[0]?.id ?? ''
  })
  const selectedModel = availableModels.find((model) => model.id === selectedModelId) ?? availableModels[0] ?? null
  useEffect(() => {
    const next = queuedFollowUps[0]
    // After a reload the browser-local stream state is idle even when the
    // durable Worker is still finishing the previous turn. Wait for the
    // authoritative native status before claiming the next queue item, then
    // poll while busy so the queue drains as soon as that turn completes.
    if (status !== 'idle' || runtimeBusy !== false || !next || next.claimed || queueDrainRef.current) return
    queueDrainRef.current = true
    void (async () => {
      let claimed: ClaimedChatPrompt | null = null
      try {
        const claimResponse = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim' }),
        })
        if (claimResponse.status === 204) { await refreshQueue(); return }
        const claimPayload = await claimResponse.json().catch(() => null) as { item?: ClaimedChatPrompt; error?: string } | null
        if (!claimResponse.ok || !claimPayload?.item) throw new Error(claimPayload?.error ?? t('消息队列认领失败'))
        claimed = claimPayload.item
        setQueuedFollowUps((current) => current.map((item) => item.id === claimed!.id ? claimed! : item))
        const finishClaim = async (complete: boolean) => {
          const finishResponse = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: complete ? 'complete' : 'release', id: claimed!.id, claimToken: claimed!.claimToken }),
          })
          if (!finishResponse.ok && finishResponse.status !== 409) throw new Error(complete ? t('消息队列出队失败') : t('消息队列释放失败'))
        }
        let receiptCompletion: Promise<void> | null = null
        const accepted = await onSubmit(claimed.text, claimed.model, {
          attachments: claimed.attachments,
          onAccepted: () => {
            setQueuedFollowUps((current) => current.filter((item) => item.id !== claimed!.id))
            receiptCompletion ??= finishClaim(true)
          },
        })
        if (receiptCompletion) await receiptCompletion
        else await finishClaim(accepted)
      } catch (error) {
        if (claimed) {
          await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'release', id: claimed.id, claimToken: claimed.claimToken }),
          }).catch(() => {})
        }
        setControlError(error instanceof Error ? error.message : t('消息队列发送失败'))
      } finally {
        await refreshQueue().catch(() => {})
        queueDrainRef.current = false
      }
    })()
  }, [onSubmit, queuedFollowUps, refreshQueue, runtimeBusy, sessionId, status])
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [promptResourceRequest, setPromptResourceRequest] = useState<{ scope: 'command' | 'mention' | 'skill'; command?: string; query: string } | null>(null)
  const [promptResources, setPromptResources] = useState<RuntimePromptResource[]>([])
  const [promptResourcesLoading, setPromptResourcesLoading] = useState(false)
  const [promptResourcesError, setPromptResourcesError] = useState(false)
  const [commandQuery, setCommandQuery] = useState<string | null>(null)
  const [liveCommands, setLiveCommands] = useState<RuntimeComposerResources['commands']>(runtimeResources?.commands ?? [])
  const [commandsLoaded, setCommandsLoaded] = useState(runtimeResources?.agent === composerResources.agent)

  const restorePastedText = useCallback((id: string) => {
    const attachment = pastedTextAttachments.find((candidate) => candidate.id === id)
    if (!attachment) return
    const textarea = promptTextareaRef.current
    const start = textarea?.selectionStart ?? input.length
    const end = textarea?.selectionEnd ?? start
    const restored = insertRestoredPastedText(input, attachment.text, start, end)
    setInput(restored.value)
    setPastedTextAttachments((current) => current.filter((candidate) => candidate.id !== id))
    setExpanded(true)
    requestAnimationFrame(() => {
      promptTextareaRef.current?.focus()
      promptTextareaRef.current?.setSelectionRange(restored.cursor, restored.cursor)
    })
  }, [input, pastedTextAttachments])

  useEffect(() => {
    setLiveCommands(runtimeResources?.agent === composerResources.agent ? runtimeResources.commands : [])
    setCommandsLoaded(runtimeResources?.agent === composerResources.agent)
  }, [composerResources.agent, runtimeResources])

  useEffect(() => {
    if (commandQuery === null) return
    const controller = new AbortController()
    let retryTimer: number | undefined
    const load = async () => {
        let response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/runtime-resources`, { cache: 'no-store', signal: controller.signal })
        if (response.status === 409 && status === 'idle') {
          const lease = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
            cache: 'no-store',
            signal: controller.signal,
          })
          if (lease.ok) response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/runtime-resources`, { cache: 'no-store', signal: controller.signal })
        }
        return response.ok ? response.json() as Promise<RuntimeComposerResources> : null
    }
    const refresh = () => {
      void load().then((payload) => {
        if (controller.signal.aborted) return
        if (payload?.agent === composerResources.agent) {
          setLiveCommands(payload.commands)
          setCommandsLoaded(true)
          return
        }
        retryTimer = window.setTimeout(refresh, 1_500)
      }).catch(() => {
        if (!controller.signal.aborted) retryTimer = window.setTimeout(refresh, 1_500)
      })
    }
    const timer = window.setTimeout(refresh, 80)
    return () => {
      window.clearTimeout(timer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      controller.abort()
    }
  }, [commandQuery, composerResources.agent, selectedModel, sessionId, status])

  useEffect(() => {
    if (composerResources.agent !== 'codex' || promptResourceRequest === null) {
      setPromptResources([])
      setPromptResourcesLoading(false)
      setPromptResourcesError(false)
      return
    }
    const controller = new AbortController()
    let retryTimer: number | undefined
    setPromptResourcesLoading(true)
    setPromptResourcesError(false)
    const load = async () => {
        const params = new URLSearchParams({ scope: promptResourceRequest.scope, query: promptResourceRequest.query })
        if (promptResourceRequest.command !== undefined) params.set('command', promptResourceRequest.command)
        const resourceUrl = `/api/chat/${encodeURIComponent(sessionId)}/prompt-resources?${params}`
        let response = await fetch(resourceUrl, { cache: 'no-store', signal: controller.signal })
        if (response.status === 409 && status === 'idle') {
          const lease = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
            cache: 'no-store',
            signal: controller.signal,
          })
          if (lease.ok) response = await fetch(resourceUrl, { cache: 'no-store', signal: controller.signal })
        }
        return response.ok ? response.json() as Promise<{ items?: RuntimePromptResource[] }> : null
    }
    const refresh = () => {
      void load().then((payload) => {
        if (controller.signal.aborted) return
        if (payload) {
          setPromptResources(Array.isArray(payload.items) ? payload.items : [])
          setPromptResourcesLoading(false)
          setPromptResourcesError(false)
          return
        }
        setPromptResourcesLoading(false)
        setPromptResourcesError(true)
        retryTimer = window.setTimeout(refresh, 1_500)
      }).catch(() => {
        if (!controller.signal.aborted) {
          setPromptResourcesLoading(false)
          setPromptResourcesError(true)
          retryTimer = window.setTimeout(refresh, 1_500)
        }
      })
    }
    const timer = window.setTimeout(refresh, 80)
    return () => {
      window.clearTimeout(timer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      controller.abort()
    }
  }, [composerResources.agent, promptResourceRequest, selectedModel, sessionId, status])

  const promptSuggestions = useMemo<AgentPromptSuggestion[]>(() => {
    const commands: AgentPromptSuggestion[] = liveCommands.map((command) => ({
        id: `${composerResources.agent}-command:${command.source}:${command.name}`,
        kind: 'command' as const,
        group: composerResources.agent === 'codex'
          ? 'Codex Commands'
          : command.source === 'skill' ? 'Pi Skills' : command.source === 'prompt' ? 'Pi Prompts' : 'Pi Extensions',
        label: `/${command.name}`,
        description: command.description || `${composerResources.agent === 'codex' ? 'Codex' : 'Pi'} ${command.source}`,
        insertText: `/${command.name} `,
        drilldown: composerResources.agent === 'codex' && ['model', 'skills', 'plugins', 'apps', 'mcp', 'permissions'].includes(command.name),
        ...(composerResources.agent === 'codex' && command.name === 'rename' ? { action: 'rename', requiresEmptyComposer: true } : {}),
        ...(composerResources.agent === 'codex' && command.name === 'status' ? { action: 'status-panel' } : {}),
        ...(composerResources.agent === 'codex' && command.name === 'plan' ? { action: 'plan-toggle', disabled: !controlReady || controlPending || status === 'streaming' } : {}),
        ...(composerResources.agent === 'codex' && command.name === 'review' ? { disabled: !controlReady || controlPending || status === 'streaming' } : {}),
        ...(composerResources.agent === 'codex' && command.name === 'fork' ? { action: 'fork', requiresEmptyComposer: true, disabled: !controlReady || controlPending || status === 'streaming' } : {}),
      }))
    if (composerResources.agent === 'codex') {
      if (!commands.some((item) => item.label === '/rename')) commands.push({ id: 'client-command:rename', kind: 'command', group: 'Chat Commands', label: '/rename', description: t('重命名当前对话'), insertText: '', action: 'rename', requiresEmptyComposer: true })
      if (!commands.some((item) => item.label === '/status')) commands.push({ id: 'client-command:status', kind: 'command', group: 'Chat Commands', label: '/status', description: t('显示会话、上下文与运行状态'), insertText: '', action: 'status-panel' })
      if (!commands.some((item) => item.label === '/fork')) commands.push({ id: 'client-command:fork', kind: 'command', group: 'Chat Commands', label: '/fork', description: t('从当前原生线程创建分支'), insertText: '', action: 'fork', requiresEmptyComposer: true, disabled: !controlReady || controlPending || status === 'streaming' })
    }
    for (const name of ['interrupt', 'pause', 'resume', 'steer', 'compact', ...(composerResources.agent === 'codex' ? ['goal', 'goal-clear', 'plan', 'default'] : [])]) {
      if (commands.some((item) => item.label === `/${name}`)) continue
      commands.push({ id: `session-control:${name}`, kind: 'command', group: t('会话控制'), label: '/' + name, description: name === 'plan' ? sessionMode === 'plan' ? t('关闭 Plan 模式') : t('开启 Plan 模式') : name === 'goal' ? t('编辑持续执行的目标') : name === 'compact' ? t('压缩当前会话上下文') : t('控制当前会话'), insertText: '/' + name + ' ',
        requiresEmptyComposer: name === 'compact',
        ...(name !== 'steer' ? { action: name === 'plan' ? 'plan-toggle' : name === 'goal' ? 'goal-editor' : name } : {}),
        disabled: !controlReady || controlPending || (status === 'streaming' && !CONTROL_ACTIONS_ALLOWED_DURING_TURN.has(name)),
      })
    }
    const dynamic: AgentPromptSuggestion[] = promptResources.map((item) => ({
      id: `native:${item.id}`,
      kind: promptResourceRequest?.scope === 'mention' ? 'mention' as const : promptResourceRequest?.scope === 'skill' ? 'skill' as const : 'command' as const,
      group: item.group,
      label: promptResourceRequest?.scope === 'command' && promptResourceRequest.command === undefined && item.command
        ? `/${item.command} · ${item.label}`
        : item.label,
      description: item.description,
      secondaryContent: item.secondaryContent,
      insertText: item.insertText,
      resourceType: item.type === 'file' || item.type === 'thread' ? item.type : undefined,
      path: item.path,
      command: promptResourceRequest?.scope === 'command' ? promptResourceRequest.command : undefined,
      replaceCommand: promptResourceRequest?.scope === 'command' && Boolean(promptResourceRequest.command) && ['skill', 'plugin', 'app'].includes(item.type),
      disabled: item.type === 'mcp',
    }))
    if (promptResourceRequest?.command === 'model') return [...commands, ...availableModels.map((model) => ({ id: `configured-model:${model.id}`, kind: 'command' as const, command: 'model', label: model.name, description: model.providerName, group: 'Models', insertText: '', replaceCommand: true, action: `model:${model.id}` }))]
    if (promptResourceRequest?.command === "permissions") return [...commands, ...(["restricted", "ask", "open"] as AccessMode[]).map((mode) => ({ id: "permissions:" + mode, kind: "command" as const, command: "permissions", label: mode, description: mode === "restricted" ? t("受限执行") : mode === "ask" ? t("请求批准") : t("完全访问"), group: "Permissions", insertText: "", replaceCommand: true, action: "permissions:" + mode, disabled: status === "streaming" || controlPending }))]
    return [
      ...commands,
      ...dynamic,
    ]
  }, [composerResources.agent, liveCommands, promptResourceRequest, promptResources, availableModels, controlPending, controlReady, status, sessionMode])

  const handleContentSizeChange = useCallback((scrollHeight: number) => {
    setExpanded((current) => promptShouldExpand(input, scrollHeight, current))
  }, [input])

  useEffect(() => {
    if (input.length === 0) setExpanded(false)
  }, [input])

  const actionButtons = (
    <>
      <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
        <ModelSelectorTrigger render={<PromptInputButton aria-label={t('选择模型，当前 {model}', { model: selectedModel?.name ?? t('未配置') })} className="h-7 w-12 shrink-0 gap-1 rounded-md px-1.5 text-[var(--app-muted)] transition-[color,background-color,border-color,opacity] active:translate-y-0! hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)] aria-expanded:bg-transparent! aria-expanded:text-[var(--app-muted)]!" type="button" />}>
          {selectedModel ? <ModelSelectorLogo className="size-4" provider={selectedModel.logo} /> : <img alt="" className="size-4" src="/openlink/model.svg" />}
          <ChevronDown className="size-4" />
        </ModelSelectorTrigger>
        <ModelSelectorContent className="w-[280px]" title={t('选择模型')}>
          <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder={t('搜索模型')} />
          <ModelSelectorList className="max-h-56 p-1">
            <ModelSelectorEmpty className="text-muted-foreground">{t('没有找到模型')}</ModelSelectorEmpty>
            <ModelSelectorGroup heading={t('模型')}>
              {availableModels.map((model) => <ModelSelectorItem className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground" key={model.id} onSelect={() => { setSelectedModelId(model.id); setModelSelectorOpen(false) }} value={`${model.name} ${model.providerName}`}><ModelSelectorLogo className="size-4" provider={model.logo} /><ModelSelectorName>{model.name}</ModelSelectorName><span className="ml-auto text-[11px] text-muted-foreground">{model.providerName}</span></ModelSelectorItem>)}
            </ModelSelectorGroup>
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    </>
  )

  return (
    <div className="relative flex w-full flex-col gap-1.5">
    {statusPanelOpen && <section aria-label={t('会话状态')} className="absolute bottom-[calc(100%+8px)] left-0 z-[90] w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-3 text-xs text-[var(--app-foreground)] shadow-[0_12px_48px_var(--app-shadow)]">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">{t("会话状态")}</h2><button aria-label={t("关闭会话状态")} className="rounded-md p-1 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => setStatusPanelOpen(false)} type="button"><X aria-hidden className="size-3.5" /></button></div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-[var(--app-muted)]">Chat ID</dt><dd className="truncate font-mono" title={sessionId}>{sessionId}</dd>
        <dt className="text-[var(--app-muted)]">Agent</dt><dd>{composerResources.agent === 'codex' ? 'Codex' : 'Pi'}</dd>
        <dt className="text-[var(--app-muted)]">{t('运行状态')}</dt><dd>{sessionPaused ? t('已暂停') : status === 'streaming' ? t('正在运行') : controlReady ? t('空闲') : t('正在连接')}</dd>
        <dt className="text-[var(--app-muted)]">{t('模式')}</dt><dd>{sessionMode === 'plan' ? 'Plan' : 'Default'}</dd>
        <dt className="text-[var(--app-muted)]">{t("模型")}</dt><dd className="truncate" title={selectedModel ? `${selectedModel.providerName} · ${selectedModel.name}` : undefined}>{selectedModel ? `${selectedModel.providerName} · ${selectedModel.name}` : t('未配置')}</dd>
        <dt className="text-[var(--app-muted)]">{t('访问权限')}</dt><dd>{accessMode}</dd>
        <dt className="text-[var(--app-muted)]">{t('上下文')}</dt><dd>{context?.usage.contextTokens == null ? t('尚无原生用量报告') : `${context.usage.contextTokens.toLocaleString()}${context.contextWindow == null ? ' tokens' : ` / ${context.contextWindow.toLocaleString()} tokens`}`}</dd>
        <dt className="text-[var(--app-muted)]">{t('速率限额')}</dt><dd>{t('当前 Provider 未提供')}</dd>
      </dl>
    </section>}
    {goalEditorOpen && <form aria-label={t('编辑 Goal')} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-3" onSubmit={async (event) => {
      event.preventDefault()
      if (!goalDraft.trim()) return
      if (sessionMode === 'plan' && !await runControl('default')) return
      if (await runControl('goal', goalDraft.trim())) setGoalEditorOpen(false)
    }}>
      <textarea autoFocus aria-label={t('目标')} maxLength={4000} value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} className="min-h-20 w-full bg-transparent text-sm outline-none" onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === 'Escape') { event.preventDefault(); setGoalEditorOpen(false) } }} />
      <div className="flex justify-end gap-3 text-xs"><button type="button" disabled={controlPending} onClick={() => setGoalEditorOpen(false)}>{t("取消")}</button><button type="submit" disabled={controlPending || !goalDraft.trim()}>{t('设置目标')}</button></div>
    </form>}
    {sessionPaused && <p role="status" className="px-1 text-xs text-[var(--app-muted)]">{t('会话已暂停 · /resume 恢复')}</p>}
    {sessionMode === "plan" && <div className="px-1 text-xs" role="status"><button aria-label={t("退出 Plan 模式")} className="rounded-md px-1.5 py-1 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] disabled:opacity-50" disabled={controlPending || status === "streaming"} onClick={() => { void runControl("default") }} title={t("退出 Plan 模式")} type="button">Plan ×</button></div>}
    {goalObjective && <div className="flex min-w-0 items-center gap-2 px-1 text-xs" role="status"><button aria-label={t("清除 Goal")} className="min-w-0 truncate rounded-md px-1.5 py-1 text-left text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] disabled:opacity-50" disabled={controlPending || status === "streaming"} onClick={() => { void runControl("goal-clear") }} title={t("清除 Goal：{objective}", { objective: goalObjective })} type="button">Goal{goalStatus ? ` (${goalStatus})` : ""} ×</button><span className="min-w-0 flex-1 truncate" title={goalObjective}>{goalObjective}</span>{goalTokens !== null && <span className="shrink-0 tabular-nums text-[var(--app-muted)]">{goalTokens} tokens</span>}</div>}
    {controlError && <p role="alert" className="px-1 text-xs text-[var(--app-danger)]">{controlError}{t('；未确认操作成功，输入已保留。')}</p>}
    {queuedFollowUps.length > 0 && <div aria-label={t('消息队列')} className="relative z-0 mx-3 -mb-3 rounded-t-xl border border-b-0 border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 pb-4 pt-2 text-xs text-[var(--app-muted)]">
      <div className="mb-1 flex items-center justify-between"><span>{t("{count} 条消息已排队", { count: queuedFollowUps.length })}</span><button className="hover:text-[var(--app-foreground)]" onClick={() => { void deleteQueuedFollowUps().catch((error) => setControlError(error instanceof Error ? error.message : t("消息队列删除失败"))) }} type="button">{t('清空')}</button></div>
      <div className="space-y-1">{queuedFollowUps.slice(0, 3).map((item, index) => <div className="group flex min-w-0 items-center gap-2" key={item.id}><span className="min-w-0 flex-1 truncate text-[var(--app-foreground)]">{item.claimed ? t("正在发送 · ") : ""}{item.text || t("{count} 个附件", { count: item.attachments.length })}</span><button aria-label={t("移除队列消息 {index}", { index: index + 1 })} className="shrink-0 opacity-60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30" disabled={item.claimed} onClick={() => { void deleteQueuedFollowUps(item.id).catch((error) => setControlError(error instanceof Error ? error.message : t("消息队列删除失败"))) }} type="button">×</button></div>)}</div>
    </div>}
    <PromptInput
      accept={undefined}
      className={`w-full [&>[data-slot=input-group]]:overflow-visible! [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:transition-[padding,border-color] [&>[data-slot=input-group]]:duration-200 [&>[data-slot=input-group]]:focus-within:ring-0 ${expanded ? '[&>[data-slot=input-group]]:h-auto [&>[data-slot=input-group]]:max-h-[384px] [&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:flex-col [&>[data-slot=input-group]]:items-stretch [&>[data-slot=input-group]]:gap-0 [&>[data-slot=input-group]]:border-[var(--app-focus-ring)] [&>[data-slot=input-group]]:p-3' : '[&>[data-slot=input-group]]:h-[42px] [&>[data-slot=input-group]]:min-h-[42px] [&>[data-slot=input-group]]:gap-1 [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:p-1.5'}`}
      maxFiles={16}
      maxFileSize={2 * 1024 * 1024}
      multiple
      onError={({ code }) => setControlError(code === 'accept' ? t('不支持该附件类型') : code === 'max_files' ? t('每次最多添加 16 个文件') : t('单个文件不能超过 2 MB'))}
      onSubmit={async ({ text, files }) => {
        const cleanText = text.trim()
        let promptAttachments: AgentPromptAttachment[]
        try {
          promptAttachments = await serializePromptAttachments(sessionId, files, pastedTextAttachments, referenceAttachments, instructionAttachments, t)
        } catch (error) {
          setControlError(error instanceof Error ? error.message : t('文件上传失败，请重试'))
          throw error
        }
        if (!cleanText && !promptAttachments.length) return
        const submittedControl = !promptAttachments.length ? /^\/(goal-clear|goal|plan|default|compact|pause|resume|interrupt|steer)(?:\s|$)/i.exec(cleanText) : null
        if (status === 'streaming' && submittedControl && !CONTROL_ACTIONS_ALLOWED_DURING_TURN.has(submittedControl[1]!.toLowerCase())) {
          setControlError(t('请等待当前回复结束后再执行 /{command}', { command: submittedControl[1]!.toLowerCase() }))
          return
        }
        if (!promptAttachments.length && status === 'streaming' && /^\/review(?:\s|$)/i.test(cleanText)) {
          setControlError(t('请等待当前回复结束后再开始 Review'))
          return
        }
        if (!promptAttachments.length && /^\/rename\s*$/i.test(text)) { onRename(); setInput(''); setExpanded(false); return }
        if (!promptAttachments.length && /^\/status\s*$/i.test(text)) { setStatusPanelOpen(true); void runControl('status'); setInput(''); setExpanded(false); return }
        if (!promptAttachments.length && /^\/fork\s*$/i.test(text)) {
          if (status === 'streaming') { setControlError(t('请等待当前回复结束后再创建分支')); return }
          if (await runControl('fork')) { setInput(''); setExpanded(false) }
          return
        }
        if (!promptAttachments.length && /^\/goal\s*$/.test(text)) { setGoalDraft(goalObjective ?? ''); setGoalEditorOpen(true); setInput(''); return }
        const modelCommand = !promptAttachments.length ? /^\/model\s+(.+?)\s*$/i.exec(text) : null
        if (modelCommand) {
          const model = availableModels.find((item) => item.modelId === modelCommand[1] || item.id === modelCommand[1])
          if (!model) { setControlError(t('该模型不在当前已配置模型中，请使用模型选择器')); return }
          setSelectedModelId(model.id)
          setInput('')
          return
        }
        if (!promptAttachments.length && /^\/(model|skills|plugins|apps|mcp|permissions)\s*$/i.test(text)) {
          setCommandQuery(text.trim().slice(1))
          setControlError(t('请从原生指令候选或模型／权限菜单中选择具体项目'))
          return
        }
        const command = !promptAttachments.length ? /^\/(goal-clear|goal|plan|default|compact|pause|resume|interrupt|steer)(?:\s+([\s\S]*))?$/.exec(cleanText) : null
        if (command) {
          const action = command[1] === 'plan' && !command[2]?.trim() ? sessionMode === 'plan' ? 'default' : 'plan'
            : command[1] === 'plan' && /^(default|code)$/i.test(command[2]?.trim() ?? '') ? 'default' : command[1]!
          if (!await runControl(action, command[2])) return
          if (action === 'plan' && command[2]?.trim() && !/^plan$/i.test(command[2].trim())) void onSubmit(command[2].trim(), selectedModel)
        } else if (status === 'streaming') {
          const forceSteer = forceSteerRef.current
          forceSteerRef.current = false
          if (forceSteer && !promptAttachments.length) {
            if (!await runControl('steer', cleanText)) throw new Error('STEER_FAILED')
          } else {
            try {
              await enqueueFollowUp(cleanText, promptAttachments, selectedModel)
            } catch (error) {
              setControlError(error instanceof Error ? error.message : t('消息加入队列失败'))
              return
            }
          }
        } else {
          if (sessionPaused) { setControlError(t('会话已暂停，请先恢复')); return }
          void onSubmit(cleanText, selectedModel, { attachments: promptAttachments })
        }
        setPastedTextAttachments([])
        setReferenceAttachments([])
        setInstructionAttachments([])
        setInput('')
        setExpanded(false)
      }}
    >
      <div className={expanded ? 'flex min-h-[54px] max-h-[330px] w-full flex-col overflow-y-auto overscroll-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'contents'}>
        <PromptAddMenu
          accessMode={accessMode}
          accessModeChangeDisabled={controlPending || status === 'streaming'}
          attachmentsEnabled
          agent={composerResources.agent}
          className={expanded ? 'ml-1' : ''}
          customInstructions={composerResources.customInstructions}
          codexResources={codexResources}
          onAccessModeChange={(mode) => { void runAccessModeChange(mode) }}
          onAddInstruction={(name, text) => {
            setInstructionAttachments((current) => current.some((attachment) => attachment.text === text) ? current : [...current, { id: crypto.randomUUID(), type: 'instruction', name, text }])
            setControlError(null)
            setExpanded(true)
          }}
          onInstallPlugin={runPluginInstall}
          pluginInstallationDisabled={controlPending || status === 'streaming'}
          onInsertText={(text) => setInput((current) => current ? `${current}\n\n${text}` : text)}
          runtimeResources={runtimeResources}
          skills={composerResources.skills}
          variant="session"
        />
        <AgentPromptTextarea
          ref={promptTextareaRef}
          aria-label={t('描述你想创建的内容')}
          lineStartCommandsOnly={composerResources.agent === 'pi'}
          commandPaletteLabel={composerResources.agent === 'codex' ? t('Codex 原生指令') : t('Pi 原生指令')}
          commandPaletteLoading={!commandsLoaded || promptResourcesLoading}
          commandPaletteEmptyLabel={promptResourcesError
            ? promptResourceRequest?.command === 'mcp' ? t('无法加载 MCP 状态') : promptResourceRequest?.command === 'skills' ? t('无法加载 Skills') : promptResourceRequest?.command === 'plugins' ? t('无法加载 Plugins') : promptResourceRequest?.command === 'apps' ? t('无法加载 Apps') : t('无法加载候选项')
            : promptResourceRequest?.command === 'mcp' ? t('未配置 MCP 服务器')
              : promptResourceRequest?.command === 'skills' ? t('没有可用 Skills')
                : promptResourceRequest?.command === 'plugins' ? t('没有已启用 Plugins')
                  : promptResourceRequest?.command === 'apps' ? t('没有可用 Apps') : t('没有匹配项')}
          className={expanded
            ? 'h-auto! min-h-0! max-h-none! w-full flex-none px-0 py-0 text-sm leading-5 text-[var(--app-foreground)] placeholder:text-[var(--app-muted)]'
            : 'h-5! min-h-5! max-h-5! flex-1 px-0 py-0 text-[13px] leading-5 text-[var(--app-foreground)] placeholder:text-[var(--app-muted)]'}
          onContentSizeChange={handleContentSizeChange}
          onKeyDown={(event) => {
            if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Escape' && statusPanelOpen) { event.preventDefault(); setStatusPanelOpen(false); return }
            if (!event.defaultPrevented && status === 'streaming' && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) forceSteerRef.current = true
          }}
          onPaste={(event) => {
            if (composerResources.agent !== 'codex' || [...event.clipboardData.items].some((item) => item.kind === 'file')) return
            const pastedText = event.clipboardData.getData('text/plain')
            if (!shouldAttachPastedText(pastedText)) return
            event.preventDefault()
            if (pastedTextAttachments.length >= PASTED_TEXT_ATTACHMENT_MAX_COUNT) {
              setControlError(t('最多添加 {count} 个粘贴文本附件', { count: PASTED_TEXT_ATTACHMENT_MAX_COUNT }))
              return
            }
            const attachment = createPastedTextAttachment(pastedText, t)
            if (!attachment) {
              setControlError(t('粘贴文本不能超过 256 KB'))
              return
            }
            setPastedTextAttachments((current) => [...current, { ...attachment, id: crypto.randomUUID() }])
            setControlError(null)
            setExpanded(true)
          }}
          onSuggestionSelect={(item) => {
            if (!item.resourceType || !item.path) return false
            const name = item.label.replace(/^@/, '').trim()
            if (!name || referenceAttachments.some((candidate) => candidate.path === item.path)) return true
            if (referenceAttachments.length >= 16) {
              setControlError(t('最多添加 16 个文件或任务引用'))
              return true
            }
            setReferenceAttachments((current) => [...current, { id: crypto.randomUUID(), type: 'reference', referenceType: item.resourceType!, name, path: item.path! }])
            setControlError(null)
            setExpanded(true)
            return true
          }}
          onTriggerChange={(trigger) => {
            setPromptResourceRequest(trigger && composerResources.agent === 'codex' && !(trigger.kind === 'command' && trigger.command === undefined)
              ? { scope: trigger.kind, ...(trigger.command !== undefined ? { command: trigger.command } : {}), query: trigger.query }
              : null)
            setCommandQuery(trigger?.kind === 'command' ? trigger.query : null)
          }}
          onValueChange={(value) => {
            setInput(value)
            if (controlError) setControlError(null)
          }}
          onAction={(action) => {
            if (action.startsWith('model:')) { setSelectedModelId(action.slice(6)); return }
            if (action.startsWith('permissions:')) { void runAccessModeChange(action.slice(12) as AccessMode); return }
            if (action === 'goal-editor') { setGoalDraft(goalObjective ?? ''); setGoalEditorOpen(true); return }
            if (action === 'rename') { onRename(); return }
            if (action === 'status-panel') { setStatusPanelOpen(true); void runControl('status'); return }
            void runControl(action === 'plan-toggle' ? sessionMode === 'plan' ? 'default' : 'plan' : action)
          }}
          placeholder=""
          suggestions={promptSuggestions}
          value={input}
          wrapperClassName={expanded ? 'w-full self-stretch' : undefined}
        />
        {pastedTextAttachments.length ? <div className="flex w-full flex-wrap gap-2 px-1 pt-1">{pastedTextAttachments.map((attachment) => <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-active)] px-2 py-1.5 text-xs" key={attachment.id}>
          <FileText aria-hidden className="size-4 shrink-0 text-[var(--app-muted)]" />
          <button className="min-w-0 flex-1 text-left" onClick={() => restorePastedText(attachment.id)} title={t("在文本框中显示")} type="button"><span className="block truncate font-medium text-[var(--app-foreground)]">{attachment.filename}</span><span className="block text-[10px] text-[var(--app-muted)]">{t('{size} bytes · 在文本框中显示', { size: pastedTextByteLength(attachment.text).toLocaleString() })}</span></button>
          <button aria-label={t('移除粘贴的文本附件')} className="shrink-0 rounded p-0.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => setPastedTextAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id))} type="button"><X aria-hidden className="size-3.5" /></button>
        </div>)}</div> : null}
        {referenceAttachments.length ? <div aria-label={t('引用')} className="flex w-full flex-wrap gap-2 px-1 pt-1">{referenceAttachments.map((attachment) => <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-active)] px-2 py-1.5 text-xs" key={attachment.id}>
          {attachment.referenceType === 'thread' ? <MessageCircle aria-hidden className="size-4 shrink-0 text-[var(--app-muted)]" /> : <FileText aria-hidden className="size-4 shrink-0 text-[var(--app-muted)]" />}
          <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--app-foreground)]">{attachment.name}</span><span className="block truncate text-[10px] text-[var(--app-muted)]">{attachment.referenceType === 'thread' ? t('任务引用') : attachment.path}</span></span>
          <button aria-label={t('移除引用 {name}', { name: attachment.name })} className="shrink-0 rounded p-0.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => setReferenceAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id))} type="button"><X aria-hidden className="size-3.5" /></button>
        </div>)}</div> : null}
        {instructionAttachments.length ? <div aria-label={t('指令')} className="flex w-full flex-wrap gap-2 px-1 pt-1">{instructionAttachments.map((attachment) => <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-active)] px-2 py-1.5 text-xs" key={attachment.id}>
          <BookOpen aria-hidden className="size-4 shrink-0 text-[var(--app-muted)]" />
          <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--app-foreground)]">{attachment.name}</span><span className="block text-[10px] text-[var(--app-muted)]">{t('指令协议')}</span></span>
          <button aria-label={t('移除指令 {name}', { name: attachment.name })} className="shrink-0 rounded p-0.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => setInstructionAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id))} type="button"><X aria-hidden className="size-3.5" /></button>
        </div>)}</div> : null}
        <ComposerAttachments />
      </div>
      <div className={expanded ? 'flex w-full shrink-0 items-end justify-between gap-1' : 'flex shrink-0 items-center gap-0.5'}>
        <div className={expanded ? 'flex min-w-0 flex-1 items-center gap-0.5' : 'contents'}>{actionButtons}</div>
        <ComposerSubmitButton disabled={controlPending || !selectedModel} hasStructuredAttachments={pastedTextAttachments.length > 0 || referenceAttachments.length > 0 || instructionAttachments.length > 0} input={input} onStop={onInterrupt} status={status} />
      </div>
    </PromptInput>
    </div>
  )
}

function PreviewCanvas({
  browserState,
  browserWorkbenchRef,
  view,
  onBrowserStateChange,
  onToggleDeviceView,
  sessionId,
  projectName,
  panelProps,
  dataSurface,
  gitVersions,
  gitVersionsLoading,
  gitVersionError,
  onSelectGitVersion,
  selectedGitRef,
}: {
  browserState: BrowserWorkbenchUiState
  browserWorkbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  view: 'mobile' | 'browser' | 'code' | 'data'
  onBrowserStateChange: (state: BrowserWorkbenchUiState) => void
  onToggleDeviceView: () => void
  sessionId: string
  projectName: string
  dataSurface: 'panel' | 'studio'
  gitVersions: GitVersionOption[]
  gitVersionsLoading: boolean
  gitVersionError: string | null
  onSelectGitVersion: (ref: string | null) => void
  selectedGitRef: string | null
  panelProps: Pick<ChatWorkspaceProps, 'activeWorkspace' | 'avatarUrl' | 'chatSessions' | 'email' | 'nickname' | 'organizations' | 'personalWorkspace' | 'projectId' | 'userId'>
}) {
  const t = useT()
  if (view === 'code') return <CodeServerWorkbench chatSessionId={sessionId} />
  if (view === 'data') {
    if (dataSurface === 'studio') return <ProjectSupabaseStudioFrame sessionId={sessionId} />
    return <ProjectSupabasePanel {...panelProps} projectName={projectName} sessionId={sessionId} embedded />
  }
  const browserMode = view === 'browser'

  return (
    <div className="flex size-full min-w-0 flex-col">
      <BrowserNavigationBar browserState={browserState} browserWorkbenchRef={browserWorkbenchRef} gitVersionError={gitVersionError} gitVersions={gitVersions} gitVersionsLoading={gitVersionsLoading} onSelectGitVersion={onSelectGitVersion} onToggleDeviceView={onToggleDeviceView} selectedGitRef={selectedGitRef} workspaceView={view} />
      <main aria-label={t('预览画布')} className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${browserMode ? theme('surface') : theme('editor')}`}>
        <div className={browserMode ? 'size-full' : 'flex size-full items-center justify-center px-4 py-[46px]'}>
          <div className={browserMode ? 'size-full' : `h-full max-h-[835px] w-[391px] max-w-full overflow-hidden rounded-xl border shadow-[0_8px_16px_-4px_var(--app-shadow),0_24px_32px_-8px_var(--app-shadow)] ${theme('surface', 'border')}`}>
            <BrowserWorkbench chatSessionId={sessionId} initialSurface={browserState.surface} onStateChange={onBrowserStateChange} ref={browserWorkbenchRef} viewportMode={view} />
          </div>
        </div>
      </main>
    </div>
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
  thinkingVisibility,
  composerResources,
}: ChatWorkspaceProps) {
  const router = useRouter()
  const t = useT()
  const navigateToFork = useCallback((path: string) => router.push(path), [router])
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false)
  const [openWorkspaceTabs, setOpenWorkspaceTabs] = useState<WorkspaceTabId[]>(['preview'])
  const [accessMode, setAccessMode] = useState<AccessMode>(initialAccessMode)
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
  const titleRequestedRef = useRef(false)
  const manualTitleRef = useRef(false)
  const [renameRequestVersion, setRenameRequestVersion] = useState(0)
  const [activeChatFlow, setActiveChatFlow] = useState<ActiveFlowStatus | null>(null)
  const [agentEvents, setAgentEvents] = useState<OpenLinkAgentEvent[]>(() => recoverInterruptedInitialEvents(initialEvents))
  const [agentStreamStatus, setAgentStreamStatus] = useState<'idle' | 'streaming'>('idle')
  const streamQueueRef = useRef<OpenLinkAgentEvent[]>([])
  const streamFrameRef = useRef<number | null>(null)
  const activeRequestAbortRef = useRef<AbortController | null>(null)
  const pendingOptimisticUserRef = useRef<OptimisticUserMessage | null>(null)
  const nextClientSequenceRef = useRef(agentEvents.reduce((maximum, event) => Math.max(maximum, event.sequence), -1) + 1)
  const autoStartHandledRef = useRef(false)
  const chatPanelRef = useRef<PanelImperativeHandle | null>(null)
  const browserWorkbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const [panelMotionActive, setPanelMotionActive] = useState(false)
  const panelMotionTimerRef = useRef<number | null>(null)
  const activeWorkspaceTabId = activeWorkspaceTab(workspaceView, browserState.surface)
  const workspaceTabsOpen = openWorkspaceTabs.length > 0
  const pendingConfirmations = useMemo(() => pendingConfirmationRequests(agentEvents), [agentEvents])

  const startPanelMotion = useCallback(() => {
    if (panelMotionTimerRef.current !== null) window.clearTimeout(panelMotionTimerRef.current)
    setPanelMotionActive(true)
    panelMotionTimerRef.current = window.setTimeout(() => {
      panelMotionTimerRef.current = null
      setPanelMotionActive(false)
    }, 320)
  }, [])

  useEffect(() => () => {
    if (panelMotionTimerRef.current !== null) window.clearTimeout(panelMotionTimerRef.current)
  }, [])

  const selectWorkspaceTab = useCallback((tab: WorkspaceTabId) => {
    setOpenWorkspaceTabs((current) => current.includes(tab) ? current : [...current, tab])
    if (tab === 'preview') {
      setWorkspaceView('browser')
      setBrowserState((current) => current.surface === 'native-preview' ? current : { ...current, surface: 'native-preview' })
      browserWorkbenchRef.current?.setSurface('native-preview')
    } else if (tab === 'realtime') {
      setWorkspaceView('browser')
      setBrowserState((current) => current.surface === 'chromium-stream' ? current : { ...current, surface: 'chromium-stream' })
      browserWorkbenchRef.current?.setSurface('chromium-stream')
    } else if (tab === 'code') {
      setWorkspaceView('code')
    } else {
      setWorkspaceView('data')
    }
  }, [])

  const closeWorkspaceTab = useCallback((tabId: WorkspaceTabId) => {
    const closingIndex = openWorkspaceTabs.indexOf(tabId)
    const remaining = openWorkspaceTabs.filter((candidate) => candidate !== tabId)
    setOpenWorkspaceTabs(remaining)
    if (remaining.length === 0) {
      // A collapsed timeline must not stay collapsed when the workspace is
      // removed: the chat becomes the sole desktop surface in this state.
      setChatPanelCollapsed(false)
      return
    }
    if (tabId === activeWorkspaceTabId) {
      const nextTab = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)]!
      selectWorkspaceTab(nextTab)
    }
  }, [activeWorkspaceTabId, openWorkspaceTabs, selectWorkspaceTab])

  const interruptAgentMessage = useCallback(() => {
    // Abort the browser-side stream immediately. The BFF abort listener sends
    // the authenticated Worker cancellation and drains the final native frame,
    // while the direct control request remains a redundant server-side stop.
    activeRequestAbortRef.current?.abort()
  }, [])
  const [gitVersions, setGitVersions] = useState<GitVersionOption[]>([])
  const [selectedGitRef, setSelectedGitRef] = useState<string | null>(null)
  const [gitVersionsLoading, setGitVersionsLoading] = useState(true)
  const [gitVersionError, setGitVersionError] = useState<string | null>(null)
  const [runtimeResources, setRuntimeResources] = useState<RuntimeComposerResources | null>(null)
  const [codexResources, setCodexResources] = useState<CodexComposerResources | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/chat/${encodeURIComponent(sessionId)}/runtime-resources`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<RuntimeComposerResources> : null)
      .then((resources) => { if (!controller.signal.aborted) setRuntimeResources(resources) })
      .catch(() => { if (!controller.signal.aborted) setRuntimeResources(null) })
    return () => controller.abort()
  }, [sessionId])

  const refreshCodexResources = useCallback(async () => {
    if (composerResources.agent !== 'codex') {
      setCodexResources(null)
      return
    }
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/codex/resources`, { cache: 'no-store' })
    if (!response.ok) {
      setCodexResources(null)
      return
    }
    const payload = await response.json() as CodexComposerResources
    setCodexResources(payload)
  }, [composerResources.agent, sessionId])

  useEffect(() => {
    void refreshCodexResources().catch(() => setCodexResources(null))
  }, [refreshCodexResources])

  const installCodexPlugin = useCallback(async (pluginId: string) => {
    if (agentStreamStatus === 'streaming') throw new Error(t('请等待当前回复结束后再安装插件'))
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/codex/plugins/${encodeURIComponent(pluginId)}/install`, { method: 'POST' })
    const payload = await response.json().catch(() => null) as CodexComposerResources | { error?: string } | null
    if (!response.ok) {
      const code = payload && 'error' in payload && typeof payload.error === 'string' ? payload.error : ''
      throw new Error(code === 'CODEX_PLUGIN_NOT_FOUND' ? t('插件已不在当前 Codex marketplace 中') : code === 'CODEX_PLUGIN_INSTALL_NOT_ALLOWED' ? t('管理员策略不允许安装此插件') : code === 'CODEX_PLUGIN_RUNTIME_REFRESH_FAILED' ? t('插件已安装，但运行时目录刷新失败；请重试加载') : t('插件安装失败，请稍后重试'))
    }
    const nextResources = payload as CodexComposerResources
    const plugin = nextResources.plugins.find((candidate) => candidate.pluginId === pluginId)
    if (!plugin?.installed || !plugin.enabled) throw new Error(t('Codex 未确认插件已安装并启用'))
    const lease = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...((workspaceView === 'browser' || workspaceView === 'mobile') && browserState.browserSessionId ? { browserSessionId: browserState.browserSessionId } : {}) }),
      cache: 'no-store',
    })
    if (!lease.ok) throw new Error(t('插件已安装，但当前会话尚未加载；请重试'))
    const params = new URLSearchParams({ scope: 'command', command: 'plugins', query: plugin.name })
    const verified = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/prompt-resources?${params}`, { cache: 'no-store' })
    const verifiedPayload = await verified.json().catch(() => null) as { items?: RuntimePromptResource[] } | null
    const expectedMention = codexPluginToken(plugin.name, plugin.displayName).trim()
    if (!verified.ok || !verifiedPayload?.items?.some((item) => item.type === 'plugin' && item.label === expectedMention)) {
      throw new Error(t('插件已安装，但 Codex Worker 尚未确认可用；请重试'))
    }
    const runtimeResponse = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/runtime-resources`, { cache: 'no-store' })
    if (runtimeResponse.ok) setRuntimeResources(await runtimeResponse.json() as RuntimeComposerResources)
    setCodexResources(nextResources)
  }, [agentStreamStatus, browserState.browserSessionId, sessionId, workspaceView])

  const changeAccessMode = useCallback(async (mode: AccessMode) => {
    if (mode === accessMode) return true
    if (agentStreamStatus === 'streaming') return false
    const previousMode = accessMode
    // The selection is optimistic. Persistence and Worker policy replacement
    // continue while sending stays gated; a failed transition restores the
    // last confirmed permission instead of making the menu feel unresponsive.
    setAccessMode(mode)
    const persistMode = async (nextMode: AccessMode) => {
      const result = await updateChatSessionAccessModeAction({ sessionId, mode: nextMode })
      if (!result.mode) console.warn(`OpenLink access mode update failed: ${result.error ?? 'unknown error'}`)
      return result.mode === nextMode
    }
    const leaseRuntime = async () => {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...((workspaceView === 'browser' || workspaceView === 'mobile') && browserState.browserSessionId ? { browserSessionId: browserState.browserSessionId } : {}),
        }),
        cache: 'no-store',
      })
      return response.ok
    }
    const readRuntimeResources = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/runtime-resources`, { cache: 'no-store' })
        if (response.ok) return await response.json() as RuntimeComposerResources
        if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 300))
      }
      return null
    }
    const result = await transitionAccessMode({ currentMode: accessMode, nextMode: mode, persistMode, leaseRuntime, readRuntimeResources })
    if (!result.ok) {
      setAccessMode(previousMode)
      if (!result.rollbackSucceeded) console.warn('OpenLink access mode rollback could not be confirmed')
      return false
    }
    setAccessMode(result.mode)
    if (result.resources) setRuntimeResources(result.resources)
    return true
  }, [accessMode, agentStreamStatus, browserState.browserSessionId, sessionId, workspaceView])

  useEffect(() => {
    const controller = new AbortController()
    setGitVersionsLoading(true)
    void fetch(`/api/chat/${encodeURIComponent(sessionId)}/git`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { versions?: unknown; error?: { message?: unknown } } | null
        if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : t('Git 版本读取失败'))
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
        setGitVersionError(error instanceof Error ? error.message : t('Git 版本读取失败'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setGitVersionsLoading(false)
      })
    return () => controller.abort()
  }, [sessionId])

  const [contextStats, setContextStats] = useState<ChatContextStats | null>(null)
  useEffect(() => {
    const invalidate = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return
      // A completed/requested compaction invalidates the previous occupancy.
      // Wait for a new native usage report instead of displaying stale totals.
      setContextStats((current) => current ? { ...current, usage: { ...current.usage, contextTokens: null } } : null)
    }
    window.addEventListener('openlink:context-invalidated', invalidate)
    return () => window.removeEventListener('openlink:context-invalidated', invalidate)
  }, [sessionId])

  useEffect(() => {
    if (agentStreamStatus === 'streaming') return
    const controller = new AbortController()
    void fetch(`/api/chat/${encodeURIComponent(sessionId)}/context`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) { setContextStats(null); return }
        const payload = await response.json().catch(() => null) as Partial<ChatContextStats> | null
        if (payload?.usage && typeof payload.usage === 'object') setContextStats(payload as ChatContextStats)
        else setContextStats(null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setContextStats(null)
      })
    return () => controller.abort()
  }, [sessionId, agentStreamStatus])

  const lastNativeUsageEvent = useMemo(() => agentEvents.findLast((event) => event.type === 'usage.updated'), [agentEvents])
  useEffect(() => {
    const usage = lastNativeUsageEvent
    if (usage?.type !== 'usage.updated') return
    setContextStats((current) => ({
      usage,
      contextWindow: usage.contextWindow ?? current?.contextWindow ?? null,
      modelId: current?.modelId ?? null,
      providerId: current?.providerId ?? null,
    }))
  }, [lastNativeUsageEvent])

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
    // Proactively prepare the Agent in the background, independently of
    // Browser startup and message receipt. Reopening should warm resources.
    let disposed = false
    const refreshLease = () => {
      void fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        cache: 'no-store',
      }).then((response) => {
        if (!response.ok && !disposed) {
          console.warn(`OpenLink agent lease refresh failed (${response.status})`)
          return
        }
        void fetch(`/api/chat/${encodeURIComponent(sessionId)}/runtime-resources`, { cache: 'no-store' })
          .then(async (resources) => resources.ok ? resources.json() as Promise<RuntimeComposerResources> : null)
          .then((resources) => { if (!disposed) setRuntimeResources(resources) })
          .catch(() => undefined)
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
  }, [sessionId])

  useEffect(() => {
    if (!browserState.browserSessionId) return
    const controller = new AbortController()
    // Bind the independently prepared Browser to the warmed Worker. Retry
    // transient creation races without delaying message receipt.
    let timer: ReturnType<typeof setTimeout> | undefined
    const bind = async () => {
      try {
        const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/lease`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ browserSessionId: browserState.browserSessionId }),
          cache: 'no-store',
          signal: controller.signal,
        })
        const result = response.ok ? await response.json() as { active?: number } : null
        if (result?.active) return
      } catch {
        if (controller.signal.aborted) return
      }
      if (!controller.signal.aborted && agentStreamStatus === 'streaming') {
        timer = setTimeout(() => { void bind() }, 3_000)
      }
    }
    void bind()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [agentStreamStatus, browserState.browserSessionId, sessionId])

  const submitAgentMessage = useCallback(async (
    message: string,
    model: PromptModelSelection | null,
    options?: { initialPrompt?: boolean; editMessageId?: string; attachments?: AgentPromptAttachment[]; onAccepted?: () => void },
  ): Promise<boolean> => {
    if (agentStreamStatus === 'streaming') throw new Error(t('请等待当前回复结束后再重发'))
    setAgentStreamStatus('streaming')
    const optimisticUser: OptimisticUserMessage = {
      id: `${sessionId}:optimistic-user:${Date.now()}`,
      text: message,
    }
    if (!options?.editMessageId) appendAgentEvents([{
      version: 1,
      id: optimisticUser.id,
      sequence: nextClientSequenceRef.current++,
      sessionId,
      timestamp: new Date().toISOString(),
      source: 'pi',
      type: 'message.user',
      messageId: optimisticUser.id,
      text: message,
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
    }])
    // Set this after the local event is appended so the reconciliation token
    // remains reserved for the server's canonical message.user event.
    pendingOptimisticUserRef.current = options?.editMessageId ? null : optimisticUser

    const requestAbortController = new AbortController()
    activeRequestAbortRef.current = requestAbortController
    let accepted = false
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: requestAbortController.signal,
        body: JSON.stringify({
          message,
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
          ...(options?.editMessageId ? { editMessageId: options.editMessageId } : {}),
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
          return true
        }
        const reason = failure?.detail || failure?.error || `Agent stream failed (${response.status})`
        throw new Error(reason === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED'
          ? t('服务商密钥无法解密，请前往设置重新保存 API Key')
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
            if (isOpenLinkAgentEvent(event)) {
              if (event.type === 'message.user' && !accepted) {
                accepted = true
                options?.onAccepted?.()
              }
              if (options?.initialPrompt && event.type === 'message.user') {
                const url = new URL(window.location.href)
                url.searchParams.delete('run')
                window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
              }
              enqueueStreamEvent(event)
            }
          }
          newline = buffer.indexOf('\n')
        }
        if (done) break
      }
      if (buffer.trim()) throw new Error('Agent stream ended with an incomplete event')
    } catch (error) {
      if (requestAbortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return accepted
      if (options?.editMessageId) throw error
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
    return accepted
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
    // Browser tools are installed before a capability exists and hot-bound
    // independently. Receipt/rendering of a turn must never await the canvas.
    autoStartHandledRef.current = true
    // Keep ?run until durable receipt so reloading during a failed network
    // submission does not strand initial_prompt without an event.
    const selectedModel = configuredModels.find((model) => (
      model.providerId === autoStartModel?.providerId && model.modelId === autoStartModel.modelId
    )) ?? configuredModels.find((model) => model.modelId === autoStartModel?.modelId) ?? null
    void submitAgentMessage(initialPrompt, selectedModel, { initialPrompt: true })
  }, [agentEvents, autoStart, autoStartModel, configuredModels, initialPrompt, submitAgentMessage])

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
      throw new Error(typeof payload?.error === 'string' ? payload.error : t('确认请求失败，请重试'))
    }
  }, [sessionId])

  const updateSessionTitle = useCallback(async (title: string) => {
    manualTitleRef.current = true
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

  useEffect(() => {
    if (composerResources.agent !== 'codex' || titleRequestedRef.current || manualTitleRef.current) return
    if (agentStreamStatus !== 'idle' || !agentEvents.some((event) => event.type === 'session.completed')) return
    titleRequestedRef.current = true
    let disposed = false
    void fetch(`/api/chat/${encodeURIComponent(sessionId)}/title`, { method: 'POST' })
      .then(async (response) => response.ok ? response.json() as Promise<{ title?: string | null }> : null)
      .then((result) => {
        if (!disposed && !manualTitleRef.current && result?.title) {
          setCurrentSessionTitle(result.title)
          router.refresh()
        }
      }).catch(() => undefined)
    return () => { disposed = true }
  }, [agentEvents, agentStreamStatus, composerResources.agent, router, sessionId])

  const [deletingSession, setDeletingSession] = useState(false)

  const deleteChat = useCallback(async (targetSessionId: string) => {
    if (deletingSession) return
    if (!window.confirm(t('确定要删除这个会话吗？删除后不可恢复。'))) return
    setDeletingSession(true)
    try {
      const result = await deleteChatSessionAction(targetSessionId)
      if (!result.ok) {
        console.error('OpenLink session delete failed:', result.error)
        return
      }
      // Navigate away only when the current session was removed. For another
      // sidebar row a refresh is enough and keeps the user in the open chat.
      if (targetSessionId === sessionId) router.replace(`/app/${activeWorkspace.slug}`)
      router.refresh()
    } finally {
      setDeletingSession(false)
    }
  }, [activeWorkspace.slug, deletingSession, router, sessionId])

  const deleteActiveChat = useCallback(async () => {
    await deleteChat(sessionId)
  }, [deleteChat, sessionId])

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
      if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : t('Git 版本切换失败'))
      if (payload?.version) setGitVersions((current) => current.map((version) => ({ ...version, current: version.ref === payload.version!.ref })))
      browserWorkbenchRef.current?.reload()
    } catch (error) {
      setSelectedGitRef(previous)
      setGitVersionError(error instanceof Error ? error.message : t('Git 版本切换失败'))
    }
  }, [selectedGitRef, sessionId])

  const toggleChatPanel = () => {
    // There is no resizable workspace panel to collapse when every workspace
    // tab is closed; keep the chat as the full-width desktop surface.
    if (!workspaceTabsOpen) {
      setChatPanelCollapsed(false)
      return
    }
    startPanelMotion()
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

  const chatTopbarProps = {
    activeTab: activeWorkspaceTabId,
    chatCollapsed: chatPanelCollapsed,
    collapsed,
    context: contextStats,
    dataSurface,
    localRuntime,
    onCloseWorkspaceTab: closeWorkspaceTab,
    onOpenSidebar: () => { setCollapsed(false); setMobileOpen(true) },
    onSessionTitleChange: updateSessionTitle,
    onToggleChat: toggleChatPanel,
    onToggleDataSurface: () => setDataSurface((surface) => surface === 'studio' ? 'panel' : 'studio'),
    onToggleSidebar: () => setCollapsed(false),
    onSelectWorkspaceTab: selectWorkspaceTab,
    openTabs: openWorkspaceTabs,
    renameRequestVersion,
    sessionTitle: currentSessionTitle,
    workspaceView,
  }

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
          onDeleteActiveChat={() => { void deleteActiveChat() }}
          onDeleteChat={(chatId) => { void deleteChat(chatId) }}
          onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }}
          onToggle={() => {
            if (mobileOpen) { setMobileOpen(false); setCollapsed(true) } else setCollapsed((value) => !value)
          }}
          organizations={organizations}
          personalWorkspace={personalWorkspace}
          themeMode={themeMode}
        />
        <PageTransition className="flex min-w-0 flex-1 flex-col bg-[var(--app-background)]">
          <div className="relative hidden min-h-0 flex-1 overflow-hidden xl:flex" data-workspace-layout={workspaceTabsOpen ? 'split' : 'chat-only'}>
            <AnimatePresence initial={false} mode="popLayout">
              {workspaceTabsOpen ? (
                <motion.div
                  animate={{ opacity: 1, x: 0 }}
                  className="absolute inset-0 min-h-0 min-w-0"
                  exit={{ opacity: 0, x: 14 }}
                  initial={{ opacity: 0, x: 14 }}
                  key="workspace-split"
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  <ResizablePanelGroup className="min-h-0" data-panel-motion={panelMotionActive ? 'active' : 'idle'} id="chat-workspace-panels" orientation="horizontal">
                    <ResizablePanel
                      collapsedSize="0px"
                      collapsible
                      defaultSize="390px"
                      groupResizeBehavior="preserve-pixel-size"
                      id="chat-panel"
                      maxSize="50%"
                      minSize="390px"
                      onResize={(size) => setChatPanelCollapsed(size.inPixels < 1)}
                      panelRef={chatPanelRef}
                    >
                      <section className="flex size-full min-w-0 flex-col overflow-hidden bg-[var(--app-background)]">
                        <ChatTopbar {...chatTopbarProps} side="chat" />
                        <ChatTimeline events={agentEvents} isStreaming={agentStreamStatus === 'streaming'} showThinkingContent={thinkingVisibility === 'summary'} onFlowStatusChange={setActiveChatFlow} onEditMessage={async (id, text) => { await submitAgentMessage(text, null, { editMessageId: id }) }} />
                        <div className="px-2 pb-2">
                          <ChatConfirmationDock onResolve={resolveConfirmation} requests={pendingConfirmations} />
                          <AccessWritesBanner sessionId={sessionId} />
                          <ChatComposer accessMode={accessMode} codexResources={codexResources} composerResources={composerResources} context={contextStats} initialModel={autoStartModel} models={configuredModels} onAccessModeChange={changeAccessMode} onFork={navigateToFork} onInstallPlugin={installCodexPlugin} onInterrupt={interruptAgentMessage} onRename={() => setRenameRequestVersion((value) => value + 1)} onSubmit={submitAgentMessage} runtimeResources={runtimeResources} sessionId={sessionId} status={agentStreamStatus} />
                        </div>
                      </section>
                    </ResizablePanel>
                    <ResizableHandle aria-label={t('调整聊天视图宽度')} className="z-20 bg-[var(--app-border)]" id="chat-resize-handle" withHandle />
                    <ResizablePanel className="min-w-0" groupResizeBehavior="preserve-relative-size" id="preview-panel" minSize="0px">
                      <section className="flex size-full min-w-0 flex-col overflow-hidden bg-[var(--app-background)]">
                        <ChatTopbar {...chatTopbarProps} side="workspace" />
                        <div className="min-h-0 min-w-0 flex-1">
                          <PreviewCanvas browserState={browserState} browserWorkbenchRef={browserWorkbenchRef} dataSurface={dataSurface} gitVersionError={gitVersionError} gitVersions={gitVersions} gitVersionsLoading={gitVersionsLoading} onBrowserStateChange={setBrowserState} onSelectGitVersion={selectGitVersion} onToggleDeviceView={() => setWorkspaceView((view) => view === 'mobile' ? 'browser' : 'mobile')} panelProps={{ activeWorkspace, avatarUrl, chatSessions, email, nickname, organizations, personalWorkspace, projectId, userId }} projectName={projectName} selectedGitRef={selectedGitRef} sessionId={sessionId} view={workspaceView} />
                        </div>
                      </section>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </motion.div>
              ) : (
                <motion.section
                  animate={{ opacity: 1, x: 0 }}
                  className="absolute inset-0 flex size-full min-w-0 flex-col items-center bg-[var(--app-background)]"
                  data-chat-panel="full"
                  exit={{ opacity: 0, x: -14 }}
                  initial={{ opacity: 0, x: -14 }}
                  key="chat-only"
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  <ChatTopbar {...chatTopbarProps} chatCollapsed={false} side="chat" showWorkspaceLauncher />
                  <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col">
                    <ChatTimeline events={agentEvents} isStreaming={agentStreamStatus === 'streaming'} showThinkingContent={thinkingVisibility === 'summary'} onFlowStatusChange={setActiveChatFlow} onEditMessage={async (id, text) => { await submitAgentMessage(text, null, { editMessageId: id }) }} />
                    <div className="px-2 pb-2">
                      <ChatConfirmationDock onResolve={resolveConfirmation} requests={pendingConfirmations} />
                      <AccessWritesBanner sessionId={sessionId} />
                      <ChatComposer accessMode={accessMode} codexResources={codexResources} composerResources={composerResources} context={contextStats} initialModel={autoStartModel} models={configuredModels} onAccessModeChange={changeAccessMode} onFork={navigateToFork} onInstallPlugin={installCodexPlugin} onInterrupt={interruptAgentMessage} onRename={() => setRenameRequestVersion((value) => value + 1)} onSubmit={submitAgentMessage} runtimeResources={runtimeResources} sessionId={sessionId} status={agentStreamStatus} />
                    </div>
                  </div>
                </motion.section>
              )}
            </AnimatePresence>
          </div>
          <div className="flex min-h-0 flex-1 xl:hidden">
            <section className="flex size-full min-w-0 flex-col bg-[var(--app-background)]">
              <ChatTopbar {...chatTopbarProps} chatCollapsed={false} side="chat" />
              <ChatTimeline events={agentEvents} isStreaming={agentStreamStatus === 'streaming'} showThinkingContent={thinkingVisibility === 'summary'} onFlowStatusChange={setActiveChatFlow} onEditMessage={async (id, text) => { await submitAgentMessage(text, null, { editMessageId: id }) }} />
              <div className="px-2 pb-2">
                <ChatConfirmationDock onResolve={resolveConfirmation} requests={pendingConfirmations} />
                <ChatComposer accessMode={accessMode} codexResources={codexResources} composerResources={composerResources} context={contextStats} initialModel={autoStartModel} models={configuredModels} onAccessModeChange={changeAccessMode} onFork={navigateToFork} onInstallPlugin={installCodexPlugin} onInterrupt={interruptAgentMessage} onRename={() => setRenameRequestVersion((value) => value + 1)} onSubmit={submitAgentMessage} runtimeResources={runtimeResources} sessionId={sessionId} status={agentStreamStatus} />
              </div>
            </section>
          </div>
        </PageTransition>
      </div>
    </OpenLinkThemeProvider>
  )
}
