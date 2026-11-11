'use client'

import '@zorker/bot-demo/styles.css'

import {
  COMPUTER_ASK,
  END_SCREEN,
  FINAL_TRANSCRIPT,
  ScreenOverlay,
  useAutoScroll,
  type PendingBeat,
  type ScreenOverlayState,
  type TranscriptEntry,
} from '@zorker/bot-demo'
import {
  AppChatHeader,
  AppCommandPalette,
  AppComposer,
  AppComputerPane,
  AppScreenLightbox,
  AppTranscript,
  createInitialSessions,
  createNewAgentSession,
  entryPreview,
  formatSidebarTime,
  replyForSession,
  sessionActivityMs,
  sessionPreview,
  titleFromMessage,
  uniqueEntryId,
  type AppSession,
  type AppSidebarRow,
} from '@zorker/bot-demo/app'
import type { ThemeMode } from '@/components/account-drawer'
import { BotSidebar } from '@/components/bot/bot-sidebar'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { PageTransition } from '@/components/ui/page-transition'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import { useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

const ASSET_BASE = '/zorker-bot-demo'

type BotWorkspaceProps = {
  activeWorkspace: ActiveWorkspaceSummary
  avatarUrl: string | null
  email: string
  nickname: string
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
  workspaceSlug: string
}

function createDemoSessions(): AppSession[] {
  return createInitialSessions().map((session) => {
    if (session.id !== 'sales-outbound') return session
    const transcript = FINAL_TRANSCRIPT.map((entry) => ({ ...entry }))
    return {
      ...session,
      transcript,
      lastEntryText: entryPreview(transcript.at(-1)) || session.lastEntryText,
    }
  })
}

export function BotWorkspace({
  activeWorkspace,
  avatarUrl,
  email,
  nickname,
  organizations,
  personalWorkspace,
  workspaceSlug,
}: BotWorkspaceProps) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const rootSize = useElementSize(rootRef)
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [sessions, setSessions] = useState<AppSession[]>(createDemoSessions)
  const [activeId, setActiveId] = useState('sales-outbound')
  const [extras, setExtras] = useState<Record<string, TranscriptEntry[]>>({})
  const [pendingMap, setPendingMap] = useState<Record<string, PendingBeat | null>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [newAgentSequence, setNewAgentSequence] = useState(1)
  const [backTarget, setBackTarget] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [computerOpen, setComputerOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [overlay, setOverlay] = useState<ScreenOverlayState | null>(null)

  const activeSession = sessions.find((session) => session.id === activeId) ?? sessions[0]
  const activeExtras = extras[activeId] ?? []
  const activeEntries = useMemo(
    () => [...activeSession.transcript, ...activeExtras],
    [activeExtras, activeSession.transcript],
  )
  const activePending = pendingMap[activeId] ?? null
  const isSales = activeId === 'sales-outbound'
  const displayName = activeSession.name

  const rows: AppSidebarRow[] = sessions.map((session) => {
    const sessionExtras = extras[session.id] ?? []
    return {
      session,
      name: session.name,
      preview: sessionPreview(session, sessionExtras),
      time: formatSidebarTime(sessionActivityMs(session, sessionExtras)),
      unread: session.unread,
    }
  })
  const botUnreadCount = sessions.reduce((count, session) => count + (session.unread ? 1 : 0), 0)
  const paletteSessions = rows.map(({ session, name }) => ({ session, name }))
  const showBack = Boolean(backTarget) || activeSession.id.startsWith('new-agent')

  useAutoScroll(transcriptRef, [activeId, activeEntries.length, activePending, displayName])

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

  const openPalette = useCallback(() => {
    setComputerOpen(false)
    setLightboxOpen(false)
    setOverlay(null)
    setPaletteOpen(true)
    setPaletteQuery('')
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    setPaletteQuery('')
  }, [])

  const selectSession = useCallback((sessionId: string) => {
    setActiveId(sessionId)
    setSessions((previous) => previous.map((session) => (
      session.id === sessionId ? { ...session, unread: false } : session
    )))
    setBackTarget(null)
    setDraft('')
    setComputerOpen(false)
    setLightboxOpen(false)
    setOverlay(null)
    setPaletteOpen(false)
    setPaletteQuery('')
  }, [])

  const createAgent = useCallback((query = '') => {
    const sequence = newAgentSequence
    setNewAgentSequence((value) => value + 1)
    const session = createNewAgentSession(sequence)
    const cleanQuery = query.trim()
    if (cleanQuery) {
      session.name = titleFromMessage(cleanQuery)
      session.title = session.name
    }
    setSessions((previous) => [session, ...previous])
    setBackTarget(activeId)
    setActiveId(session.id)
    setDraft('')
    setComputerOpen(false)
    setLightboxOpen(false)
    setOverlay(null)
    setPaletteOpen(false)
    setPaletteQuery('')
  }, [activeId, newAgentSequence])

  const goBack = useCallback(() => {
    const target = backTarget ?? 'sales-outbound'
    const current = sessions.find((session) => session.id === activeId)
    const currentExtras = extras[activeId] ?? []
    if (current?.isDraft && currentExtras.length === 0) {
      setSessions((previous) => previous.filter((session) => session.id !== activeId))
    }
    setActiveId(target)
    setBackTarget(null)
    setDraft('')
    setComputerOpen(false)
    setLightboxOpen(false)
    setOverlay(null)
  }, [activeId, backTarget, extras, sessions])

  const toggleComputer = useCallback(() => {
    setComputerOpen((open) => !open)
    setLightboxOpen(false)
    setOverlay(null)
  }, [])

  const openScreen = useCallback(() => {
    if (isSales) setOverlay({ mode: 'lightbox', origin: 'pane' })
    else setLightboxOpen(true)
  }, [isSales])

  const openComputerFromCard = useCallback(() => {
    if (isSales) setOverlay({ mode: 'lightbox', origin: 'entry' })
    else setLightboxOpen(true)
  }, [isSales])

  const sendMessage = useCallback(async () => {
    const content = draft.trim()
    if (!content || sending) return

    const sessionId = activeId
    const session = sessions.find((item) => item.id === sessionId) ?? activeSession
    const userEntry: TranscriptEntry = {
      kind: 'user-message',
      id: uniqueEntryId('user'),
      content,
      timestampMs: Date.now(),
    }

    setSending(true)
    setDraft('')
    setExtras((previous) => ({
      ...previous,
      [sessionId]: [...(previous[sessionId] ?? []), userEntry],
    }))
    setSessions((previous) => previous.map((item) => {
      if (item.id !== sessionId || !item.isDraft) return item
      const nextName = titleFromMessage(content)
      return { ...item, name: nextName, title: nextName, isDraft: false }
    }))
    setPendingMap((previous) => ({
      ...previous,
      [sessionId]: { label: 'Thinking', showLabel: true },
    }))

    await new Promise<void>((resolve) => window.setTimeout(resolve, 900))

    const replyEntry: TranscriptEntry = {
      kind: 'agent-message',
      id: uniqueEntryId('agent'),
      content: replyForSession(session, content),
      timestampMs: Date.now(),
      author: session.isGroup ? { id: 'chief-of-staff', name: 'Chief' } : undefined,
    }
    setExtras((previous) => ({
      ...previous,
      [sessionId]: [...(previous[sessionId] ?? []), replyEntry],
    }))
    setPendingMap((previous) => ({ ...previous, [sessionId]: null }))
    setSending(false)
  }, [activeId, activeSession, draft, sending, sessions])

  const createRoutine = useCallback(() => {
    const routine = {
      id: uniqueEntryId('routine'),
      name: 'Weekly follow-up',
      triggerDescription: 'Mondays at 9:00 AM',
    }
    const entry: TranscriptEntry = {
      kind: 'system',
      id: uniqueEntryId('system'),
      timestampMs: Date.now(),
      event: {
        type: 'created-routine',
        name: routine.name,
        triggerDescription: routine.triggerDescription,
      },
    }
    setExtras((previous) => ({
      ...previous,
      [activeId]: [...(previous[activeId] ?? []), entry],
    }))
    setSessions((previous) => previous.map((session) => (
      session.id === activeId
        ? { ...session, routines: [...session.routines, routine] }
        : session
    )))
  }, [activeId])

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
        setOverlay(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openPalette])

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className="bot-workspace openlink-app-shell workspace-navigation-shell flex h-dvh min-h-[560px] overflow-hidden" data-theme={activeTheme}>
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
          onNewAgent={openPalette}
          onSelect={selectSession}
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

            <div className="bot-chat-root zbd-root relative flex min-h-0 min-w-0 flex-1" data-sidebar-collapsed={collapsed ? '' : undefined} ref={rootRef}>
              <section className="zbd-chat zbd-app-chat flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="zbd-chat-header-wrap">
                  <AppChatHeader
                    assetBase={ASSET_BASE}
                    computerOpen={computerOpen}
                    displayName={displayName}
                    introRunning={false}
                    onBack={goBack}
                    onSkipIntro={() => undefined}
                    onToggleComputer={toggleComputer}
                    session={activeSession}
                    showBack={showBack}
                  />
                </div>
                <AppTranscript
                  assetBase={ASSET_BASE}
                  cardStatus="done"
                  displayName={displayName}
                  entries={activeEntries}
                  key={activeId}
                  onFinishComputer={() => setOverlay(null)}
                  onOpenComputer={openComputerFromCard}
                  onSuggestion={useSuggestion}
                  onTakeOver={() => setOverlay({ mode: 'takeover', origin: 'entry', instruction: COMPUTER_ASK })}
                  pending={activePending}
                  screen={END_SCREEN}
                  session={activeSession}
                  transcriptRef={transcriptRef}
                />
                <AppComposer
                  disabled={sending}
                  displayName={displayName}
                  onChange={setDraft}
                  onCreateRoutine={createRoutine}
                  onSend={() => {
                    void sendMessage()
                  }}
                  value={draft}
                />
              </section>

              {computerOpen ? (
                <AppComputerPane
                  assetBase={ASSET_BASE}
                  displayName={displayName}
                  isSales={isSales}
                  key={`${activeId}-computer`}
                  onClose={() => setComputerOpen(false)}
                  onOpenScreen={openScreen}
                  screen={END_SCREEN}
                  session={activeSession}
                />
              ) : null}

              {overlay && rootSize.width > 0 ? (
                <ScreenOverlay
                  assetBase={ASSET_BASE}
                  onClose={() => setOverlay(null)}
                  onFinish={() => setOverlay(null)}
                  overlay={overlay}
                  rootHeight={rootSize.height}
                  rootWidth={rootSize.width}
                  screen={END_SCREEN}
                />
              ) : null}

              {lightboxOpen && !isSales ? (
                <AppScreenLightbox
                  assetBase={ASSET_BASE}
                  displayName={displayName}
                  onClose={() => setLightboxOpen(false)}
                />
              ) : null}

              {paletteOpen ? (
                <AppCommandPalette
                  assetBase={ASSET_BASE}
                  onClose={closePalette}
                  onCreate={createAgent}
                  onQueryChange={setPaletteQuery}
                  onSelect={selectSession}
                  query={paletteQuery}
                  sessions={paletteSessions}
                />
              ) : null}
            </div>
          </main>
        </PageTransition>
      </div>
    </OpenLinkThemeProvider>
  )
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}
