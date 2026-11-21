'use client'

import '@zorker/bot-demo/styles.css'

import {
  END_SCREEN,
  type MessageReaction,
  type TranscriptEntry,
} from '@zorker/bot-demo'
import {
  AppCommandPalette,
  AppComposer,
  AppTranscript,
  type AppSession,
} from '@zorker/bot-demo/app'
import { AgentAvatar, resolveColor } from '@zorker/avatar'
import type { ThemeMode } from '@/components/account-drawer'
import { ChatConfirmationDock, type ComposerConfirmationRequest } from '@/components/chat-confirmation-dock'
import { BotWorkspaceView } from '@/components/bot/bot-workspace-view'
import { BotDetailsPane } from '@/components/bot/bot-details-pane'
import { BotMarkdown, BotPrompt } from '@/components/bot/bot-markdown'
import { BotMessageActions } from '@/components/bot/bot-message-actions'
import { BotMessageContextMenu } from '@/components/bot/bot-message-context-menu'
import { BotCreateDialog } from '@/components/bot/bot-create-dialog'
import { BotOnboarding } from '@/components/bot/bot-onboarding'
import { BotProfileDialog } from '@/components/bot/bot-profile-dialog'
import { BotRoutineDialog } from '@/components/bot/bot-routine-dialog'
import { BotSidebar, type BotSidebarRow } from '@/components/bot/bot-sidebar'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { PageTransition } from '@/components/ui/page-transition'
import type { ActiveWorkspaceSummary } from '@/components/workspace-switcher'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { BotDetail, BotRoutine, BotSummary } from '@/lib/bot-types'
import {
  OPTIMISTIC_USER_ENTRY_PREFIX,
  optimisticUserEntry,
  previewFromEntries,
  reconcileOptimisticUserEntry,
  type BotStreamUpdate,
  type BotPendingBeat,
  type BotTranscriptEntry,
} from '@/lib/bot-transcript'
import { useLocale } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed'
import { ArrowDown, Reply } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

const ASSET_BASE = '/zorker-bot-demo'

function scrollTranscriptToLatest(transcript: HTMLDivElement) {
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'instant' })
}

function replyExcerpt(content: string) {
  return content.replace(/\s+/g, ' ').trim().slice(0, 320)
}

function unreadAfter(bot: BotSummary | undefined) {
  if (!bot?.unread) return undefined
  const viewed = Date.parse(bot.lastViewedAt)
  return Number.isFinite(viewed) ? viewed : undefined
}

function ComposerFloat({ children, transcriptRef }: {
  children: ReactNode
  transcriptRef: RefObject<HTMLDivElement | null>
}) {
  const floatRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = floatRef.current
    const chat = node?.parentElement
    if (!node || !chat) return

    let previousHeight = 0
    const sync = () => {
      const height = node.offsetHeight
      if (height === previousHeight) return
      previousHeight = height
      const transcript = transcriptRef.current
      const pinned = transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 32
      chat.style.setProperty('--bot-composer-float-height', `${height}px`)
      if (pinned && transcript) transcript.scrollTop = transcript.scrollHeight
    }

    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(node, { box: 'border-box' })
    return () => {
      observer.disconnect()
      chat.style.removeProperty('--bot-composer-float-height')
    }
  }, [transcriptRef])

  return (
    <div className="bot-chat-composer-float" ref={floatRef}>
      {children}
    </div>
  )
}

type BotWorkspaceProps = {
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  email: string
  initialBot: BotDetail | null
  initialBots: BotSummary[]
  models: readonly ConfiguredModelOption[]
  nickname: string
  organizations: OrganizationSummary[]
  workspaceSlug: string
  workHostReady: boolean
}

function botAvatarUrl(bot: BotSummary): string {
  return `/api/bots/${encodeURIComponent(bot.id)}/avatar?v=${encodeURIComponent(bot.updatedAt)}`
}

function botToSession(bot: BotSummary, transcript: BotTranscriptEntry[], routines: readonly BotRoutine[] = []): AppSession {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.name,
    description: bot.description,
    avatar: bot.avatarShape,
    avatarColor: bot.avatarColor,
    avatarUrl: botAvatarUrl(bot),
    ink: resolveColor(bot.avatarColor, 'dark'),
    lastActivityMs: Date.parse(bot.lastActivityAt) || Date.now(),
    lastEntryText: bot.lastEntryText,
    isGroup: bot.kind === 'group',
    transcript,
    routines: routines.map((routine) => ({
      id: routine.id,
      name: routine.name,
      triggerDescription: routine.triggerDescription || routine.schedule,
    })),
    screenKind: 'desktop',
  }
}

/**
 * Mirror Work-host's reaction toggle locally. The server remains authoritative;
 * this only makes the chip respond on the same frame as the click.
 */
function toggleReactionRows(
  reactions: readonly MessageReaction[] | undefined,
  emoji: string,
  by = 'me',
): MessageReaction[] {
  const rows = reactions ?? []
  const exists = rows.some((reaction) => reaction.emoji === emoji && reaction.by === by)
  return exists
    ? rows.filter((reaction) => !(reaction.emoji === emoji && reaction.by === by))
    : [...rows, { emoji, by }]
}

function providerErrorMessage(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  let message = normalized
  try {
    const parsed = JSON.parse(normalized) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        const errorMessage = (error as Record<string, unknown>).message
        if (typeof errorMessage === 'string' && errorMessage.trim()) message = errorMessage
      } else if (typeof error === 'string' && error.trim()) {
        message = error
      } else if (typeof record.message === 'string' && record.message.trim()) {
        message = record.message
      }
    }
  } catch {
    // Provider errors are often plain text, not JSON.
  }
  const text = message.replace(/\s+/g, ' ').trim() || normalized
  const haystack = `${normalized.toLowerCase()} ${text.toLowerCase()}`
  if (/\b429\b|rate limit|too many requests|quota exceeded|insufficient_quota|resource_exhausted/.test(haystack)) {
    return 'Rate limit reached. Please try again shortly.'
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|incorrect api key|authentication|permission denied/.test(haystack)) {
    return 'The provider rejected the credentials. Check the API key.'
  }
  if (/\b404\b|model .*not found|not found.*model|does not exist|unknown model/.test(haystack)) {
    return 'The selected model is not available.'
  }
  if (/context (length|window)|too many tokens|maximum context|token limit|prompt is too long/.test(haystack)) {
    return "The conversation exceeded the model's context window."
  }
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout|server overloaded/.test(haystack)) {
    return 'The provider is temporarily unavailable. Please try again.'
  }
  if (/timeout|timed out|aborted|deadline exceeded/.test(haystack)) {
    return 'The provider took too long to respond. Please try again.'
  }
  if (/fetch failed|network|econn|enotfound|connection refused|socket hang up/.test(haystack)) {
    return 'Could not reach the provider. Check the endpoint and network.'
  }
  return text.length > 180 ? `${text.slice(0, 177)}…` : text
}

function friendlyRuntimeError(value: string): string {
  const messages: Record<string, string> = {
    BOT_SUBSTRATE_NOT_CONFIGURED: 'The Bot execution substrate is not configured.',
    BOT_SUBSTRATE_UNAVAILABLE: 'The Bot execution substrate is not available yet.',
    BOT_RUNTIME_UNAVAILABLE: 'The Bot computer is not available yet.',
    BOT_RUNTIME_NOT_READY: 'This Bot has no isolated computer yet.',
    BOT_RUNTIME_BUSY: 'This Bot is already working on another turn.',
    BOT_PROJECTION_RECOVERY_FAILED: 'The Bot project could not be recovered.',
    BOT_GROUP_MEMBERS_UNAVAILABLE: 'No group member computer is available yet.',
    BOT_CONFIRMATION_FAILED: 'The answer could not be delivered to the Bot.',
    BOT_REACTION_FAILED: 'The reaction could not be saved.',
    BOT_TRANSCRIPT_WRITE_FAILED: 'The Bot transcript could not be saved.',
    BOT_ROUTINE_WRITE_FAILED: 'The routine could not be saved.',
    BOT_ROUTINE_RUN_FAILED: 'The routine could not run.',
    BOT_ROUTINE_NOT_SUPPORTED: 'Groups do not run routines.',
    ROUTINE_INVALID: 'The routine schedule is invalid.',
    BOT_CREATE_FAILED: 'The Bot could not be created.',
    BOT_READ_FAILED: 'The Bot could not be loaded.',
    BOT_PROJECT_NOT_READY: 'The Bot project is not ready yet.',
    PI_SESSION_READ_FAILED: 'The Bot memory could not be read.',
    MODEL_CONFIGURATION_REQUIRED: 'Configure an AI provider for this Bot.',
    PROVIDER_API_KEY_REQUIRED: 'The selected provider needs an API key.',
    PROVIDER_CREDENTIAL_REKEY_REQUIRED: 'The selected provider credentials must be refreshed.',
    MODEL_NOT_ENABLED: 'The selected model is not enabled.',
    UNKNOWN_PROVIDER_MODEL: 'The selected model is no longer available.',
    SESSION_BUSY: 'This Bot is already working on another turn.',
  }
  return messages[value] ?? providerErrorMessage(value)
}

export function BotWorkspace({
  activeWorkspace,
  avatarUrl,
  email,
  initialBot,
  initialBots,
  models,
  nickname,
  organizations,
  workspaceSlug,
  workHostReady,
}: BotWorkspaceProps) {
  const locale = useLocale()
  const reducedMotion = useReducedMotion()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const followingLatestRef = useRef(true)
  const loadedRef = useRef(new Set<string>())
  const warmingRef = useRef(new Set<string>())
  const skipWarmOnceRef = useRef(new Set<string>())
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [bots, setBots] = useState<BotSummary[]>(initialBots)
  const [activeId, setActiveId] = useState(initialBot?.id ?? initialBots[0]?.id ?? '')
  const [unreadBoundary, setUnreadBoundary] = useState(() => ({ id: activeId, after: unreadAfter(initialBot ?? initialBots[0]) }))
  const activeIdRef = useRef(activeId)
  const [details, setDetails] = useState<Record<string, BotDetail>>(
    initialBot ? { [initialBot.id]: initialBot } : {},
  )
  const [pendingMap, setPendingMap] = useState<Record<string, BotPendingBeat | null>>({})
  const [taskTitleMap, setTaskTitleMap] = useState<Record<string, string>>({})
  const [taskStateMap, setTaskStateMap] = useState<Record<string, string | null>>({})
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({})
  const [detailFailures, setDetailFailures] = useState<Record<string, boolean>>({})
  const [warmingMap, setWarmingMap] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState('')
  const [replyTarget, setReplyTarget] = useState<{ botId: string; id: string; excerpt: string } | null>(null)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const sendQueues = useRef(new Map<string, Promise<void>>())
  const [creating, setCreating] = useState(initialBots.length === 0)
  const [onboardingName, setOnboardingName] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteView, setPaletteView] = useState<'search' | 'create'>('search')
  const [createInitialName, setCreateInitialName] = useState('')
  const [computerOpen, setComputerOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [routineEditor, setRoutineEditor] = useState<BotRoutine | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeBot = bots.find((bot) => bot.id === activeId) ?? null
  const activeBotId = activeBot?.id ?? null
  const activeBotKind = activeBot?.kind ?? null
  const activeBotStatus = activeBot?.runtimeStatus ?? null
  const activeDetail = activeBot ? details[activeBot.id] ?? null : null
  const activeTranscript = activeDetail?.transcript ?? []
  const transcriptById = useMemo(() => new Map(
    activeDetail?.transcript.map((entry) => [entry.id, entry] as const),
  ), [activeDetail?.transcript])
  const activeReply = replyTarget?.botId === activeId ? replyTarget : null
  const activeConfirmations: ComposerConfirmationRequest[] = activeDetail?.pendingConfirmations ?? []
  const activePending = pendingMap[activeId] ?? null
  const activeGroupSpeaker = activePending?.groupMember
    ? activeBot?.members.find(member => member.workAgentId === activePending.groupMember?.id) : undefined
  // The active turn supplies its task title over the event stream.
  const activeTaskTitle = taskTitleMap[activeId] || ''
  const activeTaskState = taskStateMap[activeId] ?? activePending?.state ?? 'working'
  const activeWarming = activeId ? warmingMap[activeId] === true : false
  const activeSession = activeBot ? botToSession(activeBot, activeTranscript, activeDetail?.routines) : null
  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  const rows: BotSidebarRow[] = useMemo(() => bots.map((bot) => {
    const transcript = details[bot.id]?.transcript ?? []
    const preview = bot.lastEntryText || (transcript.length ? previewFromEntries(transcript) : '')
    return {
      session: botToSession(bot, transcript, details[bot.id]?.routines),
      name: bot.name,
      preview: preview || 'No messages yet',
      unread: bot.unread,
      members: bot.kind === 'group' ? bot.members : undefined,
    }
  }), [bots, details])
  const botUnreadCount = bots.reduce((count, bot) => count + (bot.unread ? 1 : 0), 0)
  const paletteSessions = rows.map(({ session, name }) => ({ session, name }))

  const attachTranscript = useCallback((transcript: HTMLDivElement | null) => {
    if (!transcript) return
    transcriptRef.current = transcript
    followingLatestRef.current = true
    setAwayFromLatest(false)
    scrollTranscriptToLatest(transcript)

    // Fonts, media and the composer can change the height after the first paint.
    const resize = new ResizeObserver(() => {
      if (followingLatestRef.current) scrollTranscriptToLatest(transcript)
    })
    resize.observe(transcript)
    if (transcript.firstElementChild) resize.observe(transcript.firstElementChild)
    return () => {
      resize.disconnect()
      transcriptRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    if (transcript && followingLatestRef.current) scrollTranscriptToLatest(transcript)
  }, [activeId, activeDetail?.transcript, activePending, activeConfirmations.length])

  useLayoutEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme)

    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updateSystemTheme = () => setSystemLight(media.matches)
    updateSystemTheme()
    media.addEventListener('change', updateSystemTheme)
    return () => media.removeEventListener('change', updateSystemTheme)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (activeTheme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [activeTheme])

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode)
    window.localStorage.setItem('openlink-theme', mode)
  }

  const loadBot = useCallback(async (botId: string, force = false) => {
    const cached = details[botId]
    if (!force && cached && (cached.transcript.length > 0 || loadedRef.current.has(botId) || !cached.lastEntryText)) return
    const readStartedAt = Date.now()
    setLoadingMap((previous) => ({ ...previous, [botId]: true }))
    setDetailFailures((previous) => previous[botId] ? { ...previous, [botId]: false } : previous)
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { bot?: BotDetail; error?: { message?: string } } | null
      if (!response.ok || !payload?.bot) {
        throw new Error(friendlyRuntimeError(payload?.error?.message || 'BOT_READ_FAILED'))
      }
      loadedRef.current.add(botId)
      const loaded = payload.bot
      setDetails((previous) => {
        const pending = previous[botId]?.transcript.filter(entry => entry.id.startsWith(OPTIMISTIC_USER_ENTRY_PREFIX) || (entry.timestampMs ?? 0) >= readStartedAt) ?? []
        const stored = new Set(loaded.transcript.map(entry => entry.id))
        const accepted = new Set(loaded.transcript.map(entry => entry.clientNonce).filter(Boolean))
        const missed = pending.filter(entry => !stored.has(entry.id) && (!entry.clientNonce || !accepted.has(entry.clientNonce)))
        return { ...previous, [botId]: { ...loaded, transcript: [...loaded.transcript, ...missed] } }
      })
      setBots((previous) => previous.map((bot) => (
        bot.id === botId
          ? {
              ...bot,
              unread: false,
              name: payload.bot!.name,
              description: payload.bot!.description,
              avatarShape: payload.bot!.avatarShape,
              avatarColor: payload.bot!.avatarColor,
              kind: payload.bot!.kind,
              memberIds: payload.bot!.memberIds,
              members: payload.bot!.members,
              workAgentId: payload.bot!.workAgentId,
              projectId: payload.bot!.projectId,
              runtimeKey: payload.bot!.runtimeKey,
              providerId: payload.bot!.providerId,
              modelId: payload.bot!.modelId,
              lastEntryText: payload.bot!.lastEntryText || bot.lastEntryText,
              runtimeStatus: payload.bot!.runtimeStatus,
              runtimeReadyAt: payload.bot!.runtimeReadyAt,
              runtimeLastError: payload.bot!.runtimeLastError,
              runtimeCheckedAt: payload.bot!.runtimeCheckedAt,
            }
          : bot
      )))
    } catch (loadError) {
      setDetailFailures((previous) => ({ ...previous, [botId]: true }))
      setError(loadError instanceof Error ? friendlyRuntimeError(loadError.message) : 'The Bot could not be loaded.')
    } finally {
      setLoadingMap((previous) => ({ ...previous, [botId]: false }))
    }
  }, [details])

  useEffect(() => {
    if (activeId) void loadBot(activeId)
  }, [activeId, loadBot])

  const warmBot = useCallback(async (botId: string) => {
    if (warmingRef.current.has(botId)) return
    warmingRef.current.add(botId)
    setWarmingMap((previous) => ({ ...previous, [botId]: true }))
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/warm`, {
        method: 'POST',
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null) as {
        ready?: unknown
        error?: { message?: string }
      } | null
      if (!response.ok || payload?.ready !== true) {
        throw new Error(friendlyRuntimeError(payload?.error?.message || 'BOT_RUNTIME_UNAVAILABLE'))
      }
      const now = new Date().toISOString()
      setDetails((previous) => {
        const detail = previous[botId]
        return detail
          ? { ...previous, [botId]: { ...detail, runtimeReady: true, runtimeStatus: 'ready', runtimeReadyAt: now, runtimeLastError: null } }
          : previous
      })
      setBots((previous) => previous.map((bot) => (
        bot.id === botId
          ? { ...bot, runtimeStatus: 'ready', runtimeReadyAt: now, runtimeLastError: null, updatedAt: now }
          : bot
      )))
    } catch (warmError) {
      const message = warmError instanceof Error ? warmError.message : 'BOT_RUNTIME_UNAVAILABLE'
      setDetails((previous) => {
        const detail = previous[botId]
        return detail
          ? { ...previous, [botId]: { ...detail, runtimeReady: false, runtimeStatus: 'failed', runtimeLastError: message } }
          : previous
      })
      setBots((previous) => previous.map((bot) => (
        bot.id === botId ? { ...bot, runtimeStatus: 'failed', runtimeLastError: message } : bot
      )))
      setError(friendlyRuntimeError(message))
    } finally {
      warmingRef.current.delete(botId)
      setWarmingMap((previous) => ({ ...previous, [botId]: false }))
    }
  }, [])

  useEffect(() => {
    if (!workHostReady || !activeBotId || activeBotKind === 'group') return
    if (activeBotStatus === 'ready') return
    if (skipWarmOnceRef.current.delete(activeBotId)) return
    void warmBot(activeBotId)
  }, [activeBotId, activeBotKind, activeBotStatus, warmBot, workHostReady])

  useEffect(() => {
    setBots((previous) => {
      let changed = false
      const next = previous.map((bot) => {
        const detail = details[bot.id]
        if (!detail?.transcript.length) return bot
        const preview = previewFromEntries(detail.transcript)
        if (!preview || preview === bot.lastEntryText) return bot
        changed = true
        const newest = detail.transcript.reduce((latest, entry) => Math.max(latest, entry.timestampMs), 0)
        const previousActivity = Date.parse(bot.lastActivityAt)
        const activityAt = new Date(Number.isFinite(previousActivity) ? Math.max(previousActivity, newest) : newest).toISOString()
        return { ...bot, lastEntryText: preview, lastActivityAt: activityAt }
      })
      return changed ? next : previous
    })
  }, [details])

  const markViewed = useCallback((botId: string) => {
    setBots((previous) => previous.map((bot) => bot.id === botId ? { ...bot, unread: false } : bot))
    void fetch(`/api/bots/${encodeURIComponent(botId)}/view`, { method: 'POST' }).catch(() => undefined)
  }, [])

  const selectBot = useCallback((botId: string) => {
    setUnreadBoundary({ id: botId, after: unreadAfter(bots.find((bot) => bot.id === botId)) })
    setActiveId(botId)
    setError(null)
    setDraft('')
    setReplyTarget(null)
    setAwayFromLatest(false)
    setComputerOpen(false)
    setDetailsOpen(false)
    setProfileOpen(false)
    setRoutineEditor(null)
    setPaletteOpen(false)
    setPaletteView('search')
    setPaletteQuery('')
    markViewed(botId)
    void loadBot(botId, true)
  }, [bots, loadBot, markViewed])

  const applyRoutines = useCallback((botId: string, routines: BotRoutine[]) => {
    setDetails((previous) => {
      const detail = previous[botId]
      return detail ? { ...previous, [botId]: { ...detail, routines } } : previous
    })
  }, [])

  const readRoutines = useCallback(async (response: Response): Promise<BotRoutine[]> => {
    const payload = await response.json().catch(() => null) as {
      routines?: BotRoutine[]
      error?: { message?: string }
    } | null
    if (!response.ok || !Array.isArray(payload?.routines)) {
      throw new Error(friendlyRuntimeError(payload?.error?.message || 'BOT_ROUTINE_WRITE_FAILED'))
    }
    return payload.routines
  }, [])

  const toggleRoutine = useCallback(async (routine: BotRoutine, isEnabled: boolean) => {
    if (!activeBot) return
    try {
      const response = await fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/routines/${encodeURIComponent(routine.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isEnabled }),
          cache: 'no-store',
        },
      )
      applyRoutines(activeBot.id, await readRoutines(response))
    } catch (toggleError) {
      setError(toggleError instanceof Error ? friendlyRuntimeError(toggleError.message) : 'The routine could not be updated.')
    }
  }, [activeBot, applyRoutines, readRoutines])

  const saveRoutine = useCallback(async (spec: {
    name: string
    prompt: string
    schedule: string
    isEnabled: boolean
  }) => {
    if (!activeBot || !routineEditor) return
    const response = await fetch(
      `/api/bots/${encodeURIComponent(activeBot.id)}/routines/${encodeURIComponent(routineEditor.id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
        cache: 'no-store',
      },
    )
    applyRoutines(activeBot.id, await readRoutines(response))
    setRoutineEditor(null)
  }, [activeBot, applyRoutines, readRoutines, routineEditor])

  const deleteRoutine = useCallback(async () => {
    const routine = routineEditor
    if (!activeBot || !routine?.id) return
    const response = await fetch(
      `/api/bots/${encodeURIComponent(activeBot.id)}/routines/${encodeURIComponent(routine.id)}`,
      { method: 'DELETE', cache: 'no-store' },
    )
    applyRoutines(activeBot.id, await readRoutines(response))
    setRoutineEditor(null)
  }, [activeBot, applyRoutines, readRoutines, routineEditor])

  const refreshRoster = useCallback(async () => {
    const response = await fetch(`/api/bots?workspace=${encodeURIComponent(workspaceSlug)}`, { cache: 'no-store' }).catch(() => null)
    if (!response?.ok) return
    const data = await response.json().catch(() => null) as { bots?: BotSummary[] } | null
    const current = data?.bots
    if (!Array.isArray(current)) return
    setBots(previous => {
      const previousById = new Map(previous.map(bot => [bot.id, bot]))
      return current.map(bot => {
        const local = previousById.get(bot.id)
        return local && local.updatedAt > bot.updatedAt ? local : bot
      })
    })
  }, [workspaceSlug])

  useEffect(() => {
    if (!workHostReady) return
    const refreshIfVisible = () => { if (!document.hidden) void refreshRoster() }
    const timer = window.setInterval(refreshIfVisible, 25_000)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.clearInterval(timer)
    }
  }, [refreshRoster, workHostReady])

  const applyUpdate = useCallback((botId: string, update: BotStreamUpdate) => {
    if (update.type === 'management') {
      if (update.routines) {
        void fetch(`/api/bots/${encodeURIComponent(botId)}/routines`, { cache: 'no-store' })
          .then(readRoutines).then(routines => applyRoutines(botId, routines)).catch(() => undefined)
      } else void refreshRoster()
      return
    }
    if (update.type === 'pending') {
      setPendingMap((previous) => {
        const currentEpoch = previous[botId]?.groupEpoch
        const nextEpoch = update.pending?.groupEpoch
        return currentEpoch !== undefined && nextEpoch !== undefined && nextEpoch < currentEpoch
          ? previous : { ...previous, [botId]: update.pending }
      })
      return
    }
    if (update.type === 'avatar-state') {
      setTaskStateMap((previous) => previous[botId] === update.state ? previous : { ...previous, [botId]: update.state })
      return
    }
    if (update.type === 'title') {
      setTaskTitleMap((previous) => ({ ...previous, [botId]: update.title }))
      return
    }
    if (update.type === 'delta') {
      // The first streamed token replaces the typing beat: the assistant is
      // now writing in the timeline, so a separate pending row would trail it.
      setPendingMap((previous) => (previous[botId] ? { ...previous, [botId]: null } : previous))
      setDetails((previous) => {
        const detail = previous[botId]
        if (!detail) return previous
        const index = detail.transcript.findIndex((entry) => entry.id === update.id)
        if (index === -1) {
          const entry: BotTranscriptEntry = {
            kind: 'agent-message',
            id: update.id,
            content: update.delta,
            timestampMs: Date.now(),
          }
          return { ...previous, [botId]: { ...detail, transcript: [...detail.transcript, entry] } }
        }
        const existing = detail.transcript[index]
        if (existing.kind !== 'agent-message') return previous
        const transcript = [...detail.transcript]
        transcript[index] = { ...existing, content: `${existing.content}${update.delta}` }
        return { ...previous, [botId]: { ...detail, transcript } }
      })
      return
    }
    if (update.type === 'entry') {
      if (update.entry.kind === 'agent-message' && !update.entry.hostReceipt) {
        setPendingMap((previous) => previous[botId] && previous[botId]?.groupEpoch === undefined ? { ...previous, [botId]: null } : previous)
      }
      setDetails((previous) => {
        const detail = previous[botId]
        if (!detail) return previous
        return { ...previous, [botId]: { ...detail, transcript: reconcileOptimisticUserEntry(detail.transcript, update.entry) } }
      })
      return
    }
    if (update.type === 'confirmation') {
      setDetails((previous) => {
        const detail = previous[botId]
        if (!detail) return previous
        const pendingConfirmations = detail.pendingConfirmations.some((request) => request.id === update.request.id)
          ? detail.pendingConfirmations.map((request) => request.id === update.request.id ? update.request : request)
          : [...detail.pendingConfirmations, update.request]
        return { ...previous, [botId]: { ...detail, pendingConfirmations } }
      })
      return
    }
    if (update.type === 'confirmation-resolved') {
      setDetails((previous) => {
        const detail = previous[botId]
        if (!detail) return previous
        return {
          ...previous,
          [botId]: {
            ...detail,
            transcript: detail.transcript.map((entry) => (
              entry.kind === 'confirmation' && entry.confirmation.id === update.id
                ? { ...entry, confirmation: { ...entry.confirmation, status: 'answered' as const } }
                : entry
            )),
            pendingConfirmations: detail.pendingConfirmations.filter((request) => request.id !== update.id),
          },
        }
      })
      return
    }
    if (update.type === 'error') {
      setError(friendlyRuntimeError(update.message))
      setPendingMap((previous) => ({ ...previous, [botId]: null }))
      return
    }
    if (update.type === 'done') {
      setPendingMap((previous) => ({ ...previous, [botId]: null }))
      if (update.group) void refreshRoster()
    }
  }, [applyRoutines, readRoutines, refreshRoster])

  const reactToBotMessage = useCallback(async (
    botId: string,
    entryId: string,
    emoji: string,
  ) => {
    const applyToggle = () => {
      setDetails((previous) => {
        const detail = previous[botId]
        if (!detail) return previous
        const index = detail.transcript.findIndex((entry) => entry.id === entryId)
        if (index === -1) return previous
        const entry = detail.transcript[index]
        if (entry.kind !== 'agent-message' && entry.kind !== 'user-message') return previous
        const transcript = [...detail.transcript]
        transcript[index] = { ...entry, reactions: toggleReactionRows(entry.reactions, emoji) }
        return { ...previous, [botId]: { ...detail, transcript } }
      })
    }
    applyToggle()
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId, emoji }),
      cache: 'no-store',
    }).catch(() => null)
    if (response?.ok) return
    // Work-host owns the toggle. If it refused, put the chip back where it was.
    applyToggle()
    const payload = await response?.json().catch(() => null) as { error?: { message?: string } } | null
    setError(friendlyRuntimeError(payload?.error?.message || 'BOT_REACTION_FAILED'))
  }, [])

  const catchUpBotEvents = useEffectEvent((botId: string) => { void loadBot(botId, true) })

  // A Bot is not request-scoped. Keep the active Bot's projection open so a
  // routine run, a channel reply, or any other turn started outside this tab
  // lands in the timeline without a manual refresh.
  useEffect(() => {
    if (!workHostReady || !activeId) return
    const source = new EventSource(`/api/bots/${encodeURIComponent(activeId)}/events`)
    source.onopen = () => catchUpBotEvents(activeId)
    source.onmessage = (event) => {
      try {
        applyUpdate(activeId, JSON.parse(event.data) as BotStreamUpdate)
      } catch {}
    }
    return () => source.close()
  }, [activeId, applyUpdate, workHostReady])

  const resolveBotConfirmation = useCallback(async (
    botId: string,
    confirmationId: string,
    approved: boolean,
    value?: string,
  ) => {
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: confirmationId,
        ...(value !== undefined ? { value } : { approved }),
      }),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(friendlyRuntimeError(payload?.error?.message || 'CONFIRMATION_FAILED'))
    }
    setDetails((previous) => {
      const detail = previous[botId]
      if (!detail) return previous
      return {
        ...previous,
        [botId]: {
          ...detail,
          transcript: detail.transcript.map((entry) => (
            entry.kind === 'confirmation' && entry.confirmation.id === confirmationId
              ? { ...entry, confirmation: { ...entry.confirmation, status: 'answered' as const } }
              : entry
          )),
          pendingConfirmations: detail.pendingConfirmations.filter((request) => request.id !== confirmationId),
        },
      }
    })
  }, [])

  const sendMessage = useCallback(() => {
    const content = draft.trim().slice(0, 10_000)
    if (!content || !activeBot || !activeDetail?.runtimeReady) return
    const botId = activeBot.id
    const sentReply = activeReply
    const clientNonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const optimisticId = `${OPTIMISTIC_USER_ENTRY_PREFIX}${clientNonce}`
    const optimistic = { ...optimisticUserEntry(optimisticId, content, sentReply?.id), clientNonce }

    followingLatestRef.current = true
    setAwayFromLatest(false)
    setDraft('')
    setReplyTarget(null)
    setError(null)
    setDetails((previous) => {
      const detail = previous[botId]
      if (!detail) return previous
      return { ...previous, [botId]: { ...detail, transcript: [...detail.transcript, optimistic] } }
    })

    const submit = async () => {
      try {
        const send = () => fetch(`/api/bots/${encodeURIComponent(botId)}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: content, clientNonce, replyToId: sentReply?.id, acceptOnly: true }),
        })
        const response = await send().catch(send)
        const receipt = await response.json().catch(() => null) as {
          accepted?: boolean; entryId?: string; error?: { message?: string }
        } | null
        if (!response.ok || !receipt?.accepted || typeof receipt.entryId !== 'string') {
          throw new Error(friendlyRuntimeError(receipt?.error?.message || 'BOT_RUNTIME_UNAVAILABLE'))
        }
        const entryId = receipt.entryId
        setDetails((previous) => {
          const detail = previous[botId]
          if (!detail || detail.transcript.some(entry => entry.id === entryId)) return previous
          return { ...previous, [botId]: { ...detail, transcript: reconcileOptimisticUserEntry(detail.transcript, { ...optimistic, id: entryId }) } }
        })
      } catch (sendError) {
        if (activeIdRef.current === botId) {
          setDraft(current => current ? `${content}\n\n${current}` : content)
          setReplyTarget(current => current ?? sentReply)
          setError(sendError instanceof Error ? friendlyRuntimeError(sendError.message) : 'The message could not be sent.')
        }
        setDetails((previous) => {
          const detail = previous[botId]
          if (!detail) return previous
          return { ...previous, [botId]: { ...detail, transcript: detail.transcript.filter(entry => entry.id !== optimisticId) } }
        })
      }
    }

    // Keep acceptance ordered per chat. The model runs independently after Work-host commits the input.
    const queued = (sendQueues.current.get(botId) ?? Promise.resolve()).then(submit)
    sendQueues.current.set(botId, queued)
    void queued.finally(() => {
      if (sendQueues.current.get(botId) === queued) sendQueues.current.delete(botId)
    })
  }, [activeBot, activeDetail?.runtimeReady, activeReply, draft])

  const openPalette = useCallback((view: 'search' | 'create' = 'search') => {
    setComputerOpen(false)
    setDetailsOpen(false)
    setPaletteOpen(true)
    setPaletteView(view)
    setCreateInitialName('')
    setPaletteQuery('')
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    setPaletteView('search')
    setPaletteQuery('')
  }, [])

  const openComputer = useCallback(() => {
    if (!activeBot || activeBot.kind === 'group') {
      setError('This Bot has no isolated computer yet.')
      return
    }
    setDetailsOpen(false)
    setComputerOpen(true)
  }, [activeBot])

  const toggleDetails = useCallback(() => {
    if (!activeBot) return
    setDetailsOpen((open) => !open)
    setComputerOpen(false)
  }, [activeBot])

  const jumpToMessage = useCallback((entryId: string) => {
    window.requestAnimationFrame(() => {
      const target = transcriptRef.current?.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`)
      if (!target) return
      followingLatestRef.current = false
      target.scrollIntoView({ block: 'center' })
    })
  }, [])

  const showAttachment = useCallback((entryId: string) => {
    if (window.matchMedia('(max-width: 767px)').matches) setDetailsOpen(false)
    jumpToMessage(entryId)
  }, [jumpToMessage])

  const useSuggestion = useCallback((suggestion: string) => {
    setDraft(suggestion)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.zbd-app-composer-input')?.focus()
    })
  }, [])

  const startReply = useCallback((entryId: string, content: string) => {
    setReplyTarget({ botId: activeId, id: entryId, excerpt: replyExcerpt(content) })
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.zbd-app-composer-input')?.focus({ preventScroll: true })
    })
  }, [activeId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openPalette()
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openPalette])

  const handleProfileSaved = useCallback((updated: BotSummary) => {
    setBots((previous) => previous.map((bot) => bot.id === updated.id ? { ...bot, ...updated } : bot))
    setDetails((previous) => {
      const detail = previous[updated.id]
      if (!detail) return previous
      return {
        ...previous,
        [updated.id]: {
          ...detail,
          ...updated,
          transcript: detail.transcript,
          pendingConfirmations: detail.pendingConfirmations,
          routines: detail.routines,
        },
      }
    })
  }, [])

  const handleProfileDeleted = useCallback((botId: string) => {
    const remaining = bots
      .filter((bot) => bot.id !== botId)
      .flatMap((bot) => {
        if (bot.kind !== 'group' || !bot.memberIds.includes(botId)) return [bot]
        const memberIds = bot.memberIds.filter((id) => id !== botId)
        // The server deletes a group that loses its last member; mirror that
        // so the sidebar cannot point at a group that no longer exists.
        if (!memberIds.length) return []
        return [{ ...bot, memberIds, members: bot.members.filter((member) => member.id !== botId) }]
      })
    setBots(remaining)
    setActiveId((current) => remaining.some((bot) => bot.id === current) ? current : (remaining[0]?.id ?? ''))
    setDetails((previous) => {
      const keep = new Set(remaining.map((bot) => bot.id))
      return Object.fromEntries(Object.entries(previous).filter(([id]) => keep.has(id)))
    })
    setProfileOpen(false)
    window.history.replaceState(null, '', `/app/${encodeURIComponent(workspaceSlug)}/bots`)
  }, [bots, workspaceSlug])

  const handleCreated = useCallback((bot: BotSummary) => {
    const runtimeReady = bot.runtimeStatus === 'ready'
    if (runtimeReady) skipWarmOnceRef.current.add(bot.id)
    setBots((previous) => [bot, ...previous.filter((item) => item.id !== bot.id)])
    setDetails((previous) => ({
      ...previous,
      [bot.id]: {
        ...bot,
        transcript: [],
        runtimeReady,
        runtimeStatus: bot.runtimeStatus ?? 'pending',
        pendingConfirmations: [],
        routines: [],
      },
    }))
    setActiveId(bot.id)
    setWarmingMap((previous) => ({ ...previous, [bot.id]: false }))
    setCreating(false)
    setOnboardingName('')
    setPaletteOpen(false)
    setPaletteView('search')
    setCreateInitialName('')
    window.history.replaceState(null, '', `/app/${encodeURIComponent(workspaceSlug)}/bots?bot=${encodeURIComponent(bot.id)}`)
    // The create response is a summary; load the durable detail so an
    // existing group transcript and the routine/confirmation projections are
    // real immediately, not only after the first turn.
    void loadBot(bot.id, true)
  }, [loadBot, workspaceSlug])

  if (!activeBot || creating) {
    return (
      <OpenLinkThemeProvider theme={activeTheme}>
        <div className="bot-workspace openlink-app-shell" data-theme={activeTheme}>
          <BotOnboarding
            firstBot={bots.length === 0}
            initialName={onboardingName}
            models={models}
            onCancel={bots.length ? () => { setCreating(false); setOnboardingName('') } : undefined}
            onCreated={handleCreated}
            theme={activeTheme}
            workHostReady={workHostReady}
            workspaceName={activeWorkspace.name}
            workspaceSlug={workspaceSlug}
          />
        </div>
      </OpenLinkThemeProvider>
    )
  }

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className="bot-workspace openlink-app-shell workspace-navigation-shell relative flex h-dvh min-h-[560px] overflow-hidden" data-theme={activeTheme}>
        <BotSidebar
          activeId={activeId}
          activeWorkspace={activeWorkspace}
          avatarUrl={avatarUrl}
          botUnreadCount={botUnreadCount}
          collapsed={collapsed}
          email={email}
          mobileOpen={mobileOpen}
          nickname={nickname}
          onCloseMobile={() => setMobileOpen(false)}
          onNewAgent={() => openPalette('create')}
          onSelect={selectBot}
          onThemeChange={handleThemeChange}
          onToggle={() => {
            if (window.matchMedia('(min-width: 768px)').matches) setCollapsed((value) => !value)
            else setMobileOpen((value) => !value)
          }}
          organizations={organizations}
          rows={rows}
          themeMode={themeMode}
          workspaceSlug={workspaceSlug}
        />

        <PageTransition className="flex min-w-0 flex-1">
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-background)]">
            <div className="bot-chat-root zbd-root relative flex min-h-0 min-w-0 flex-1" data-sidebar-collapsed={collapsed ? '' : undefined}>
              <section className="zbd-chat zbd-app-chat flex min-h-0 min-w-0 flex-1 flex-col">
                <button
                  aria-label={`Open ${activeBot.name} details`}
                  aria-expanded={detailsOpen}
                  className="bot-chat-profile-trigger"
                  onClick={toggleDetails}
                  type="button"
                >
                  <AgentAvatar
                    className="shrink-0"
                    color={activeBot.avatarColor}
                    renderer="complete"
                    shape={activeBot.avatarShape}
                    size={32}
                    state="idle"
                    theme={activeTheme}
                  />
                  <span className="min-w-0 truncate">{activeBot.name}</span>
                  {activeBot.kind === 'group' ? <span className="bot-group-member-count">{activeBot.members.length}</span> : null}
                </button>
                {!activeDetail ? (
                  detailFailures[activeId] && !loadingMap[activeId] ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-[13px] text-[var(--app-muted)]" role="alert">
                      <span>Conversation history is temporarily unavailable.</span>
                      <button className="zbd-app-empty-suggestion" onClick={() => { void loadBot(activeId, true) }} type="button">Retry</button>
                    </div>
                  ) : (
                    <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--app-muted)]" role="status">
                      Loading {activeBot.name}…
                    </div>
                  )
                ) : (
                  <>
                    {activeBot.runtimeStatus === 'failed' || activeBot.runtimeLastError ? (
                      <div
                        className="mx-[21px] mt-3 flex items-center gap-3 rounded-[12px] border border-[var(--app-border)] bg-[var(--app-elevated)] px-3.5 py-2.5 text-[12px] leading-[18px] text-[var(--app-foreground)]"
                        role="alert"
                      >
                        <span className="min-w-0 flex-1 text-[var(--app-danger)]">
                          {friendlyRuntimeError(activeBot.runtimeLastError || 'BOT_RUNTIME_UNAVAILABLE')}
                        </span>
                        <button
                          className="flex h-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-control-border)] px-2.5 text-[11px] font-medium text-[var(--app-foreground)] hover:bg-[var(--app-hover)] disabled:pointer-events-none disabled:opacity-50"
                          disabled={activeWarming}
                          onClick={() => { void warmBot(activeBot.id) }}
                          type="button"
                        >
                          {activeWarming ? 'Retrying…' : 'Retry'}
                        </button>
                      </div>
                    ) : null}
                    <AppTranscript
                      assetBase={ASSET_BASE}
                      cardStatus="done"
                      displayName={activeBot.name}
                      entries={activeTranscript as TranscriptEntry[]}
                      getReplyAction={(entry) => entry.id.startsWith(OPTIMISTIC_USER_ENTRY_PREFIX)
                        ? undefined : () => startReply(entry.id, entry.content)}
                      key={activeId}
                      locale={locale}
                      onFinishComputer={() => undefined}
                      onOpenComputer={openComputer}
                      onReact={(entry, emoji) => {
                        void reactToBotMessage(activeId, entry.id, emoji)
                      }}
                      onScroll={({ currentTarget: transcript }) => {
                        const away = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 100
                        followingLatestRef.current = !away
                        setAwayFromLatest(away)
                      }}
                      onSuggestion={useSuggestion}
                      onTakeOver={openComputer}
                      pending={null}
                      renderGroupAvatar={({ id, name }) => {
                        const member = activeBot.members.find(item => item.workAgentId === id)
                        return member ? (
                          <button aria-label={locale.startsWith('zh') ? `打开与 ${name} 的对话` : `Open chat with ${name}`} className="bot-group-author-avatar" onClick={() => selectBot(member.id)} type="button">
                            <AgentAvatar color={member.avatarColor} interactive={false} shape={member.avatarShape} size={36} theme={activeTheme} />
                          </button>
                        ) : null
                      }}
                      renderMessage={(content) => <BotMarkdown content={content} members={activeBot.kind === 'group' ? activeBot.members : undefined} />}
                      renderPrompt={(content) => <BotPrompt content={content} members={activeBot.kind === 'group' ? activeBot.members : undefined} />}
                      renderMessageActions={(actions) => <BotMessageActions actions={actions} />}
                      renderMessageMenu={(bubble, actions) => (
                        <BotMessageContextMenu actions={actions} bubble={bubble} requestId={transcriptById.get(actions.entry.id)?.requestId} />
                      )}
                      renderReplyReference={(entry) => {
                        const target = entry.replyTo ? transcriptById.get(entry.replyTo) : undefined
                        const repliedMessage = target?.kind === 'agent-message' || target?.kind === 'user-message' ? target : undefined
                        const excerpt = repliedMessage ? replyExcerpt(repliedMessage.content) : locale.startsWith('zh') ? '早前消息' : 'Earlier message'
                        const author = repliedMessage?.kind === 'agent-message'
                          ? repliedMessage.author?.name ?? activeBot.name
                          : repliedMessage ? locale.startsWith('zh') ? '你' : 'You' : undefined
                        return (
                          <button className="bot-sent-reply" disabled={!repliedMessage} onClick={repliedMessage ? () => jumpToMessage(repliedMessage.id) : undefined} title={excerpt} type="button">
                            <Reply aria-hidden="true" size={13} />
                            {author ? <strong>{author}</strong> : null}
                            <span>{excerpt}</span>
                          </button>
                        )
                      }}
                      replyTargetId={activeReply?.id}
                      unreadAfter={unreadBoundary.id === activeId ? unreadBoundary.after : undefined}
                      status={activePending ? (
                        <>
                          <div aria-hidden="true" className="bot-task-avatar">
                            <AgentAvatar
                              color={activeGroupSpeaker?.avatarColor ?? activeBot.avatarColor}
                              interactive={false}
                              reducedMotion={reducedMotion === true}
                              renderer="complete"
                              shape={activeGroupSpeaker?.avatarShape ?? activeBot.avatarShape}
                              size={36}
                              state={activeBot.kind === 'group' ? activePending.state ?? 'working' : activeTaskState}
                              theme={activeTheme}
                            />
                          </div>
                          <span className="bot-task-label" role="status">{activeBot.kind === 'group' ? activePending.label || 'Group discussion' : activeTaskTitle || 'Working'}</span>
                        </>
                      ) : null}
                      screen={END_SCREEN}
                      session={activeSession!}
                      transcriptRef={attachTranscript}
                    />
                  </>
                )}
                <ComposerFloat transcriptRef={transcriptRef}>
                  {awayFromLatest ? (
                    <button
                      aria-label="Jump to latest message"
                      className="bot-jump-latest"
                      onClick={() => {
                        const transcript = transcriptRef.current
                        if (!transcript) return
                        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                        transcript.scrollTo({ top: transcript.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' })
                      }}
                      type="button"
                    >
                      <ArrowDown aria-hidden="true" size={16} />
                    </button>
                  ) : null}
                  <ChatConfirmationDock
                    onResolve={(id, approved, value) => resolveBotConfirmation(activeBot.id, id, approved, value)}
                    requests={activeConfirmations}
                  />
                  <AppComposer
                    disabled={!activeDetail?.runtimeReady}
                    displayName={activeBot.name}
                    groupMembers={activeBot.kind === 'group' ? activeBot.members : undefined}
                    onChange={setDraft}
                    showRoutine={false}
                    onSend={() => {
                      void sendMessage()
                    }}
                    reply={activeReply ? {
                      excerpt: activeReply.excerpt,
                      onCancel: () => setReplyTarget(null),
                      onJump: () => jumpToMessage(activeReply.id),
                    } : undefined}
                    replyPlaceholder={locale.startsWith('zh') ? '回复…' : 'Reply…'}
                    value={draft}
                  />
                </ComposerFloat>
              </section>

              {detailsOpen ? (
                <BotDetailsPane
                  bot={activeBot}
                  key={activeBot.id}
                  theme={activeTheme}
                  routines={activeDetail?.routines ?? []}
                  transcript={activeTranscript}
                  onClose={() => setDetailsOpen(false)}
                  onEditProfile={() => setProfileOpen(true)}
                  onEditRoutine={setRoutineEditor}
                  onOpenComputer={openComputer}
                  onOpenMember={selectBot}
                  onMentionMember={(name) => {
                    setDraft(previous => `${previous.trimEnd()}${previous.trim() ? ' ' : ''}@${name} `)
                    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.zbd-app-composer-input')?.focus({ preventScroll: true }))
                  }}
                  onShowAttachment={showAttachment}
                  onToggleRoutine={(routine, isEnabled) => { void toggleRoutine(routine, isEnabled) }}
                />
              ) : computerOpen && activeBot.kind !== 'group' ? (
                <BotWorkspaceView
                  avatarColor={activeBot.avatarColor}
                  avatarShape={activeBot.avatarShape}
                  botId={activeBot.id}
                  botName={activeBot.name}
                  theme={activeTheme}
                  onClose={() => setComputerOpen(false)}
                />
              ) : null}

            </div>
          </main>
        </PageTransition>

        {paletteOpen || profileOpen || routineEditor ? (
          <div className="zbd-root absolute inset-0 z-40" style={{ background: 'transparent', borderRadius: 0, boxShadow: 'none' }}>
                {paletteOpen && paletteView === 'create' ? (
                  <BotCreateDialog
                    initialName={createInitialName}
                    models={models}
                    workHostReady={workHostReady}
                    onBack={() => {
                      setPaletteQuery(createInitialName)
                      setPaletteView('search')
                    }}
                    onClose={closePalette}
                    onCreated={(bot) => {
                      closePalette()
                      handleCreated(bot)
                    }}
                    theme={activeTheme}
                    workspaceSlug={workspaceSlug}
                  />
                ) : paletteOpen ? (
                  <AppCommandPalette
                    assetBase={ASSET_BASE}
                    onClose={closePalette}
                    onCreate={(query) => {
                      setCreateInitialName(query.trim())
                      setPaletteView('create')
                    }}
                    onQueryChange={setPaletteQuery}
                    onSelect={(sessionId) => {
                      closePalette()
                      selectBot(sessionId)
                    }}
                    query={paletteQuery}
                    sessions={paletteSessions}
                  />
                ) : null}

                {profileOpen ? (
                  <BotProfileDialog
                    bot={activeBot}
                    bots={bots}
                    models={models}
                    theme={activeTheme}
                    onClose={() => setProfileOpen(false)}
                    onDeleted={handleProfileDeleted}
                    onSaved={handleProfileSaved}
                  />
                ) : null}

                {routineEditor ? (
                  <BotRoutineDialog
                    botName={activeBot.name}
                    onClose={() => setRoutineEditor(null)}
                    onDelete={deleteRoutine}
                    onSave={saveRoutine}
                    routine={routineEditor}
                  />
                ) : null}
          </div>
        ) : null}

        {error ? (
          <button
            className="absolute bottom-24 left-1/2 z-50 max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-full border border-[var(--app-border)] bg-[var(--app-elevated)] px-4 py-2 text-[12px] text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)]"
            onClick={() => setError(null)}
            type="button"
          >
            {error}
          </button>
        ) : null}
      </div>
    </OpenLinkThemeProvider>
  )
}
