'use client'

import '@zorker/bot-demo/styles.css'

import {
  END_SCREEN,
  useAutoScroll,
  type PendingBeat,
  type TranscriptEntry,
} from '@zorker/bot-demo'
import {
  AppChatHeader,
  AppCommandPalette,
  AppComposer,
  AppTranscript,
  formatSidebarTime,
  type AppSession,
  type AppSidebarRow,
} from '@zorker/bot-demo/app'
import { resolveColor } from '@zorker/avatar'
import type { ThemeMode } from '@/components/account-drawer'
import { ChatConfirmationDock, type ComposerConfirmationRequest } from '@/components/chat-confirmation-dock'
import { BotComputerLightbox, BotComputerPane } from '@/components/bot/bot-computer'
import { BotCreateDialog } from '@/components/bot/bot-create-dialog'
import { BotOnboarding } from '@/components/bot/bot-onboarding'
import { BotProfileDialog } from '@/components/bot/bot-profile-dialog'
import { BotRoutineDialog } from '@/components/bot/bot-routine-dialog'
import { BotSidebar } from '@/components/bot/bot-sidebar'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { PageTransition } from '@/components/ui/page-transition'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { BotDetail, BotRoutine, BotSummary } from '@/lib/bot-types'
import {
  previewFromEntries,
  type BotStreamUpdate,
  type BotTranscriptEntry,
} from '@/lib/bot-transcript'
import { useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ASSET_BASE = '/zorker-bot-demo'

type BotWorkspaceProps = {
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  email: string
  initialBot: BotDetail | null
  initialBots: BotSummary[]
  models: readonly ConfiguredModelOption[]
  nickname: string
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
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

function upsertEntry(
  transcript: BotTranscriptEntry[],
  entry: BotTranscriptEntry,
): BotTranscriptEntry[] {
  const index = transcript.findIndex((candidate) => candidate.id === entry.id)
  if (index === -1) return [...transcript, entry]
  const next = [...transcript]
  next[index] = entry
  return next
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
    BOT_TRANSCRIPT_WRITE_FAILED: 'The Bot transcript could not be saved.',
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
  return messages[value] ?? value
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
  personalWorkspace,
  workspaceSlug,
  workHostReady,
}: BotWorkspaceProps) {
  const t = useT()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(new Set<string>())
  const warmingRef = useRef(new Set<string>())
  const skipWarmOnceRef = useRef(new Set<string>())
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [bots, setBots] = useState<BotSummary[]>(initialBots)
  const [activeId, setActiveId] = useState(initialBot?.id ?? initialBots[0]?.id ?? '')
  const [details, setDetails] = useState<Record<string, BotDetail>>(
    initialBot ? { [initialBot.id]: initialBot } : {},
  )
  const [pendingMap, setPendingMap] = useState<Record<string, PendingBeat | null>>({})
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({})
  const [warmingMap, setWarmingMap] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(initialBots.length === 0)
  const [onboardingName, setOnboardingName] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteView, setPaletteView] = useState<'search' | 'create'>('search')
  const [createInitialName, setCreateInitialName] = useState('')
  const [computerOpen, setComputerOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [routineEditor, setRoutineEditor] = useState<{ routine: BotRoutine | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeBot = bots.find((bot) => bot.id === activeId) ?? null
  const activeBotId = activeBot?.id ?? null
  const activeBotKind = activeBot?.kind ?? null
  const activeBotStatus = activeBot?.runtimeStatus ?? null
  const activeDetail = activeBot ? details[activeBot.id] ?? null : null
  const activeTranscript = activeDetail?.transcript ?? []
  const activeConfirmations: ComposerConfirmationRequest[] = activeDetail?.pendingConfirmations ?? []
  const activePending = pendingMap[activeId] ?? null
  const activeWarming = activeId ? warmingMap[activeId] === true : false
  const activeSession = activeBot ? botToSession(activeBot, activeTranscript, activeDetail?.routines) : null
  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  const rows: AppSidebarRow[] = useMemo(() => bots.map((bot) => {
    const transcript = details[bot.id]?.transcript ?? []
    const preview = bot.lastEntryText || (transcript.length ? previewFromEntries(transcript) : '')
    return {
      session: botToSession(bot, transcript, details[bot.id]?.routines),
      name: bot.name,
      preview: preview || 'No messages yet',
      time: formatSidebarTime(Date.parse(bot.lastActivityAt) || Date.now(), Date.now()),
      unread: bot.unread,
    }
  }), [bots, details])
  const botUnreadCount = bots.reduce((count, bot) => count + (bot.unread ? 1 : 0), 0)
  const paletteSessions = rows.map(({ session, name }) => ({ session, name }))

  useAutoScroll(transcriptRef, [activeId, activeTranscript.length, activePending, activeConfirmations.length, activeBot?.name])

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
    setLoadingMap((previous) => ({ ...previous, [botId]: true }))
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { bot?: BotDetail; error?: { message?: string } } | null
      if (!response.ok || !payload?.bot) {
        throw new Error(friendlyRuntimeError(payload?.error?.message || 'BOT_READ_FAILED'))
      }
      setDetails((previous) => ({ ...previous, [botId]: payload.bot! }))
      setBots((previous) => previous.map((bot) => (
        bot.id === botId
          ? {
              ...bot,
              unread: false,
              lastEntryText: payload.bot!.lastEntryText || bot.lastEntryText,
              runtimeStatus: payload.bot!.runtimeStatus,
              runtimeReadyAt: payload.bot!.runtimeReadyAt,
              runtimeLastError: payload.bot!.runtimeLastError,
              runtimeCheckedAt: payload.bot!.runtimeCheckedAt,
            }
          : bot
      )))
    } catch (loadError) {
      setError(loadError instanceof Error ? friendlyRuntimeError(loadError.message) : 'The Bot could not be loaded.')
    } finally {
      loadedRef.current.add(botId)
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
    setActiveId(botId)
    setError(null)
    setDraft('')
    setComputerOpen(false)
    setLightboxOpen(false)
    setProfileOpen(false)
    setRoutineEditor(null)
    setPaletteOpen(false)
    setPaletteView('search')
    setPaletteQuery('')
    markViewed(botId)
    void loadBot(botId, true)
  }, [loadBot, markViewed])

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

  const saveRoutine = useCallback(async (spec: {
    name: string
    prompt: string
    schedule: string
    isEnabled: boolean
  }) => {
    if (!activeBot) return
    const routine = routineEditor?.routine && routineEditor.routine.id ? routineEditor.routine : null
    const response = await fetch(
      routine
        ? `/api/bots/${encodeURIComponent(activeBot.id)}/routines/${encodeURIComponent(routine.id)}`
        : `/api/bots/${encodeURIComponent(activeBot.id)}/routines`,
      {
        method: routine ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
        cache: 'no-store',
      },
    )
    applyRoutines(activeBot.id, await readRoutines(response))
    setRoutineEditor(null)
  }, [activeBot, applyRoutines, readRoutines, routineEditor])

  const deleteRoutine = useCallback(async () => {
    const routine = routineEditor?.routine
    if (!activeBot || !routine?.id) return
    const response = await fetch(
      `/api/bots/${encodeURIComponent(activeBot.id)}/routines/${encodeURIComponent(routine.id)}`,
      { method: 'DELETE', cache: 'no-store' },
    )
    applyRoutines(activeBot.id, await readRoutines(response))
    setRoutineEditor(null)
  }, [activeBot, applyRoutines, readRoutines, routineEditor])

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

  const runRoutine = useCallback(async (routine: BotRoutine) => {
    if (!activeBot) return
    try {
      const response = await fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/routines/${encodeURIComponent(routine.id)}/run`,
        { method: 'POST', cache: 'no-store' },
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(payload?.error?.message || 'BOT_ROUTINE_RUN_FAILED')
      }
      void loadBot(activeBot.id, true)
    } catch (runError) {
      setError(runError instanceof Error ? friendlyRuntimeError(runError.message) : 'The routine could not run.')
    }
  }, [activeBot, loadBot])

  const applyUpdate = useCallback((botId: string, update: BotStreamUpdate) => {
    if (update.type === 'pending') {
      setPendingMap((previous) => ({ ...previous, [botId]: update.pending }))
      return
    }
    if (update.type === 'delta') {
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
      setDetails((previous) => {
        const detail = previous[botId]
        if (!detail) return previous
        return { ...previous, [botId]: { ...detail, transcript: upsertEntry(detail.transcript, update.entry) } }
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
      setSending(false)
    }
  }, [])

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
          pendingConfirmations: detail.pendingConfirmations.filter((request) => request.id !== confirmationId),
        },
      }
    })
  }, [])

  const sendMessage = useCallback(async () => {
    const content = draft.trim()
    if (!content || sending || activeWarming || !activeBot || !activeDetail?.runtimeReady) return
    const botId = activeBot.id
    let accepted = false
    setSending(true)
    setDraft('')
    setError(null)
    setPendingMap((previous) => ({ ...previous, [botId]: { label: 'Working', showLabel: true } }))
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(friendlyRuntimeError(payload?.error?.message || 'BOT_RUNTIME_UNAVAILABLE'))
      }
      if (!response.body) throw new Error('The Bot returned no response stream.')
      accepted = true
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            applyUpdate(botId, JSON.parse(data) as BotStreamUpdate)
          } catch {}
        }
      }
    } catch (sendError) {
      if (!accepted) setDraft((current) => current || content)
      setError(sendError instanceof Error ? friendlyRuntimeError(sendError.message) : 'The Bot could not finish this turn.')
    } finally {
      setSending(false)
      setPendingMap((previous) => ({ ...previous, [botId]: null }))
      void loadBot(botId, true)
    }
  }, [activeBot, activeDetail?.runtimeReady, activeWarming, applyUpdate, draft, loadBot, sending])

  const openPalette = useCallback(() => {
    setComputerOpen(false)
    setLightboxOpen(false)
    setPaletteOpen(true)
    setPaletteView('search')
    setCreateInitialName('')
    setPaletteQuery('')
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    setPaletteView('search')
    setPaletteQuery('')
  }, [])

  const toggleComputer = useCallback(() => {
    if (!activeBot || activeBot.kind === 'group') {
      setError('This Bot has no isolated computer yet.')
      return
    }
    setComputerOpen((open) => !open)
    setLightboxOpen(false)
  }, [activeBot])

  const openComputer = useCallback(() => {
    if (!activeBot || activeBot.kind === 'group') {
      setError('This Bot has no isolated computer yet.')
      return
    }
    setLightboxOpen(true)
    setComputerOpen(false)
  }, [activeBot])

  const useSuggestion = useCallback((suggestion: string) => {
    setDraft(suggestion)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.zbd-app-composer-input')?.focus()
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openPalette()
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setLightboxOpen(false)
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
    const remaining = bots.filter((bot) => bot.id !== botId)
    setBots(remaining)
    setActiveId((current) => current === botId ? (remaining[0]?.id ?? '') : current)
    setDetails((previous) => {
      const next = { ...previous }
      delete next[botId]
      return next
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
  }, [workspaceSlug])

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
          onNewAgent={() => {
            openPalette()
          }}
          onSelect={selectBot}
          onThemeChange={handleThemeChange}
          onToggle={() => {
            if (mobileOpen) {
              setMobileOpen(false)
              setCollapsed(true)
            } else {
              setCollapsed((value) => !value)
            }
          }}
          organizations={organizations}
          personalWorkspace={personalWorkspace}
          rows={rows}
          themeMode={themeMode}
          workspaceSlug={workspaceSlug}
        />

        <PageTransition className="flex min-w-0 flex-1">
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-background)]">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3 md:hidden">
              <button
                aria-label={t('打开侧边栏')}
                className="flex size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)]"
                onClick={() => {
                  setCollapsed(false)
                  setMobileOpen(true)
                }}
                type="button"
              >
                <span className="flex w-4 flex-col gap-1"><i className="h-px w-4 bg-[var(--app-muted)]" /><i className="h-px w-4 bg-[var(--app-muted)]" /><i className="h-px w-4 bg-[var(--app-muted)]" /></span>
              </button>
              <span className="truncate text-sm font-medium text-[var(--app-foreground)]">{activeWorkspace.name}</span>
            </div>

            <div className="bot-chat-root zbd-root relative flex min-h-0 min-w-0 flex-1" data-sidebar-collapsed={collapsed ? '' : undefined}>
              <section className="zbd-chat zbd-app-chat flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="zbd-chat-header-wrap">
                  <AppChatHeader
                    assetBase={ASSET_BASE}
                    computerAvailable={activeBot.kind !== 'group'}
                    computerOpen={computerOpen}
                    displayName={activeBot.name}
                    introRunning={false}
                    onBack={() => undefined}
                    onOpenProfile={() => setProfileOpen(true)}
                    onSkipIntro={() => undefined}
                    onToggleComputer={toggleComputer}
                    session={activeSession!}
                    showBack={false}
                  />
                </div>
                {loadingMap[activeId] && !activeDetail ? (
                  <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--app-muted)]">
                    Loading {activeBot.name}…
                  </div>
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
                      key={activeId}
                      onFinishComputer={() => setLightboxOpen(false)}
                      onOpenComputer={openComputer}
                      onSuggestion={useSuggestion}
                      onTakeOver={openComputer}
                      pending={activePending}
                      screen={END_SCREEN}
                      session={activeSession!}
                      transcriptRef={transcriptRef}
                    />
                  </>
                )}
                <ChatConfirmationDock
                  onResolve={(id, approved, value) => resolveBotConfirmation(activeBot.id, id, approved, value)}
                  requests={activeConfirmations}
                />
                <AppComposer
                  disabled={sending || activeWarming || !activeDetail?.runtimeReady}
                  displayName={activeBot.name}
                  onChange={setDraft}
                  onCreateRoutine={() => setRoutineEditor({ routine: null })}
                  onSend={() => {
                    void sendMessage()
                  }}
                  showRoutine
                  value={draft}
                />
              </section>

              {computerOpen && activeBot.kind !== 'group' ? (
                <BotComputerPane
                  botName={activeBot.name}
                  botId={activeBot.id}
                  routines={activeDetail?.routines ?? []}
                  onEditRoutine={(routine) => setRoutineEditor({ routine })}
                  onClose={() => setComputerOpen(false)}
                  onRunRoutine={(routine) => void runRoutine(routine)}
                  onToggleRoutine={(routine, isEnabled) => void toggleRoutine(routine, isEnabled)}
                />
              ) : null}

              {lightboxOpen && activeBot.kind !== 'group' ? (
                <BotComputerLightbox
                  botName={activeBot.name}
                  botId={activeBot.id}
                  onClose={() => setLightboxOpen(false)}
                />
              ) : null}

              {paletteOpen && paletteView === 'create' ? (
                <BotCreateDialog
                  bots={bots}
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
                  onDelete={routineEditor.routine ? deleteRoutine : undefined}
                  onSave={saveRoutine}
                  routine={routineEditor.routine}
                />
              ) : null}
            </div>
          </main>
        </PageTransition>

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
