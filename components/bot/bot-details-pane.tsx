'use client'

import { AgentAvatar } from '@zorker/avatar'
import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import { PaneResizeHandle, usePaneResize } from '@/components/bot/bot-pane-resize'
import type { BotInspirationState, BotRoutine, BotSummary } from '@/lib/bot-types'
import type { BotTranscriptEntry } from '@/lib/bot-transcript'
import {
  Activity,
  Brain,
  CalendarPlus,
  Clock3,
  Cpu,
  FileText,
  FolderOpen,
  Image,
  Globe,
  MessageSquare,
  Monitor,
  Terminal,
  Trash2,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

type BotDetailsPaneProps = {
  bot: BotSummary
  theme: 'light' | 'dark'
  routines: readonly BotRoutine[]
  transcript: readonly BotTranscriptEntry[]
  onClose: () => void
  onEditProfile: () => void
  onEditRoutine: (routine: BotRoutine | null) => void
  onOpenComputer: () => void
  onShowAttachment: (entryId: string) => void
  onToggleRoutine: (routine: BotRoutine, isEnabled: boolean) => void
}

type DetailsTab = 'activity' | 'library'
type LibraryFilter = 'all' | 'media' | 'file'

type MemoryRow = {
  id: string
  content: string
  createdAt: number
  kind: 'profile' | 'log'
}

const TABS: Array<{ value: DetailsTab; label: string }> = [
  { value: 'activity', label: 'Activity' },
  { value: 'library', label: 'Library' },
]

const LIBRARY_FILTERS: Array<{ value: LibraryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'media', label: 'Media' },
  { value: 'file', label: 'Files' },
]

const PANE_MIN_WIDTH = 288
const PANE_MAX_WIDTH = 680
const INITIAL_ATTACHMENT_COUNT = 5

const MEMORY_ERRORS: Record<string, string> = {
  BOT_MEMORIES_READ_FAILED: 'The Bot memory could not be read.',
  BOT_MEMORIES_WRITE_FAILED: 'The Bot memory could not be changed.',
  BOT_RUNTIME_NOT_READY: 'This Bot has no isolated computer yet.',
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

function formatRelative(timestampMs: number | null | undefined): string {
  if (timestampMs == null) return 'Not scheduled'
  const diff = timestampMs - Date.now()
  const abs = Math.abs(diff)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs >= 86_400_000) return formatter.format(Math.round(diff / 86_400_000), 'day')
  if (abs >= 3_600_000) return formatter.format(Math.round(diff / 3_600_000), 'hour')
  if (abs >= 60_000) return formatter.format(Math.round(diff / 60_000), 'minute')
  return diff >= 0 ? 'in a moment' : 'just now'
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function botStatus(bot: BotSummary): { label: string; dot: string; description: string } {
  if (bot.kind === 'group') {
    return {
      label: 'Group',
      dot: 'bg-[var(--app-muted)]',
      description: `${bot.members.length} member${bot.members.length === 1 ? '' : 's'}`,
    }
  }
  if (bot.runtimeStatus === 'ready') {
    return { label: 'Active', dot: 'bg-emerald-500', description: 'Computer awake' }
  }
  if (bot.runtimeStatus === 'failed') {
    return { label: 'Unavailable', dot: 'bg-red-500', description: bot.runtimeLastError ? 'Runtime error' : 'Not available' }
  }
  if (bot.runtimeStatus === 'provisioning') {
    return { label: 'Starting', dot: 'bg-amber-500', description: 'Computer starting' }
  }
  return { label: 'Asleep', dot: 'bg-[var(--app-muted)]', description: 'Computer asleep' }
}

function computerState(bot: BotSummary) {
  if (bot.kind === 'group') return 'Not available'
  if (bot.runtimeStatus === 'ready') return 'Awake'
  if (bot.runtimeStatus === 'failed') return 'Unavailable'
  return 'Asleep'
}

function DetailsToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="relative flex h-5 w-8 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)] disabled:opacity-40"
      disabled={disabled}
      onClick={onChange}
      role="switch"
      style={{ background: checked ? 'var(--app-submit-background)' : 'color-mix(in srgb, var(--app-foreground) 12%, transparent)' }}
      type="button"
    >
      <span
        aria-hidden
        className="size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.22)] transition-transform"
        style={{ transform: checked ? 'translateX(12px)' : 'translateX(2px)' }}
      />
    </button>
  )
}

function Section({
  action,
  children,
  id,
  title,
}: {
  action?: ReactNode
  children: ReactNode
  id: string
  title: string
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex min-h-5 items-center justify-between gap-3 px-0.5">
        <h2 className="text-[13px] leading-4 text-[var(--app-muted)]" id={id}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-3 py-1.5">
      <span className="flex size-4 shrink-0 items-center justify-center text-[var(--app-muted)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--app-foreground)]">{label}</span>
      <span className="max-w-[55%] truncate text-[12px] text-[var(--app-muted)]" title={value}>{value}</span>
    </div>
  )
}

function EmptyCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-4 py-5 text-center text-[13px] leading-5 text-[var(--app-muted)]">
      {children}
    </div>
  )
}

/**
 * The right-hand Bot surface. Its tabs keep the profile and tools together,
 * give automations both scheduled routines and the proactive subscription,
 * and make memory and usage first-class views rather than form fields.
 */
export function BotDetailsPane({
  bot,
  theme,
  routines,
  transcript,
  onClose,
  onEditProfile,
  onEditRoutine,
  onOpenComputer,
  onShowAttachment,
  onToggleRoutine,
}: BotDetailsPaneProps) {
  const [tab, setTab] = useState<DetailsTab>('activity')
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all')
  const [showAllAttachments, setShowAllAttachments] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const [memories, setMemories] = useState<MemoryRow[] | null>(null)
  const [memoriesError, setMemoriesError] = useState<string | null>(null)
  const [memoriesBusy, setMemoriesBusy] = useState(false)
  const [inspiration, setInspiration] = useState<BotInspirationState | null>(null)
  const [activityError, setActivityError] = useState<string | null>(null)
  const pane = usePaneResize({
    defaultWidth: 440,
    minWidth: PANE_MIN_WIDTH,
    maxWidth: PANE_MAX_WIDTH,
    storageKey: 'openlink-bot-details-width',
  })
  const status = botStatus(bot)
  const tabId = (value: DetailsTab) => `bot-details-tab-${value}`
  const panelId = (value: DetailsTab) => `bot-details-panel-${value}`

  useEffect(() => {
    setLibraryFilter('all')
    setShowAllAttachments(false)
    setShowUsage(false)
    setMemories(null)
    setMemoriesError(null)
    setInspiration(null)
    setActivityError(null)
  }, [bot.id])

  const loadMemories = useCallback(async () => {
    setMemories(null)
    setMemoriesBusy(true)
    setMemoriesError(null)
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/memories`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as {
        memories?: MemoryRow[]
        error?: { message?: string }
      } | null
      if (!response.ok) throw new Error(payload?.error?.message || 'BOT_MEMORIES_READ_FAILED')
      setMemories(Array.isArray(payload?.memories) ? payload.memories : [])
    } catch (error) {
      setMemories([])
      setMemoriesError(MEMORY_ERRORS[error instanceof Error ? error.message : ''] ?? 'The Bot memory could not be read.')
    } finally {
      setMemoriesBusy(false)
    }
  }, [bot.id])

  useEffect(() => {
    if (tab !== 'library' || memories !== null || memoriesBusy) return
    void loadMemories()
  }, [loadMemories, memories, memoriesBusy, tab])

  useEffect(() => {
    if (tab !== 'activity' || !showUsage || inspiration !== null) return
    let cancelled = false
    void fetch(`/api/bots/${encodeURIComponent(bot.id)}/inspiration`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { inspiration?: BotInspirationState } | null
        if (!response.ok || !payload?.inspiration) throw new Error('INSPIRATION_READ_FAILED')
        if (!cancelled) setInspiration(payload.inspiration)
      })
      .catch(() => {
        if (!cancelled) setActivityError('Proactive activity could not be loaded.')
      })
    return () => { cancelled = true }
  }, [bot.id, inspiration, showUsage, tab])

  const removeMemory = async (memoryId: string) => {
    const previous = memories
    setMemories((current) => current?.filter((memory) => memory.id !== memoryId) ?? current)
    const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/memories`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId }),
      cache: 'no-store',
    }).catch(() => null)
    if (response?.ok) return
    setMemories(previous)
    const payload = await response?.json().catch(() => null) as { error?: { message?: string } } | null
    setMemoriesError(MEMORY_ERRORS[payload?.error?.message || ''] ?? 'The memory could not be removed.')
  }

  const clearMemories = async () => {
    if (!memories?.length) return
    if (!window.confirm(`Clear all ${memories.length} memories for ${bot.name}?`)) return
    const previous = memories
    setMemories([])
    const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/memories`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
      cache: 'no-store',
    }).catch(() => null)
    if (response?.ok) return
    setMemories(previous)
    const payload = await response?.json().catch(() => null) as { error?: { message?: string } } | null
    setMemoriesError(MEMORY_ERRORS[payload?.error?.message || ''] ?? 'The memory could not be cleared.')
  }

  const ledger = inspiration?.ledger ?? []
  const acted = ledger.filter((record) => record.outcome === 'acted')
  const proactiveMessages = ledger.reduce((total, record) => total + record.messageCount, 0)
  const proactiveSpend = inspiration?.usage.usd ?? 0
  const latestRuns = [...ledger].sort((left, right) => right.createdAt - left.createdAt).slice(0, 5)

  const attachments = transcript.flatMap(({ id, timestampMs, attachment }) => (
    attachment && (libraryFilter === 'all' || attachment.kind === libraryFilter)
      ? [{ id, timestampMs, ...attachment }]
      : []
  )).sort((left, right) => right.timestampMs - left.timestampMs)
  const visibleAttachments = showAllAttachments ? attachments : attachments.slice(0, INITIAL_ATTACHMENT_COUNT)

  return (
    <aside
      aria-label={`${bot.name} details`}
      className="zbd-side-pane bot-profile-pane shrink-0"
      style={{ width: pane.width }}
    >
      <PaneResizeHandle
        maxWidth={PANE_MAX_WIDTH}
        minWidth={PANE_MIN_WIDTH}
        onNudge={pane.nudge}
        onPointerDown={pane.beginResize}
        resizing={pane.resizing}
        width={pane.width}
      />
      <div className="zbd-side-pane-inner">
        <div className="bot-profile-toolbar">
          <button aria-label="Close details" className="zbd-window-action" onClick={onClose} type="button">
            <X className="size-4" />
          </button>
        </div>
        <div className="bot-profile-scroll">
          <header className="bot-profile-identity">
            <button aria-label="Edit Bot profile" className="bot-profile-avatar" onClick={onEditProfile} title="Edit profile" type="button">
              <AgentAvatar
                color={bot.avatarColor}
                interactive={false}
                renderer="complete"
                shape={bot.avatarShape}
                size={64}
                state="idle"
                theme={theme}
              />
              <span
                aria-hidden="true"
                className={`absolute bottom-0.5 right-0.5 size-3 rounded-full ring-[3px] ring-[var(--app-background)] ${status.dot}`}
                title={status.label}
              />
            </button>
            <h1>{bot.name}</h1>
            <p>{bot.description || status.description}</p>
          </header>

          <div aria-label="Bot profile views" className="bot-profile-tabs" role="tablist">
            {TABS.map(({ value, label }) => (
              <button
                aria-controls={panelId(value)}
                aria-selected={tab === value}
                id={tabId(value)}
                key={value}
                onClick={() => setTab(value)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const next = value === 'activity' ? 'library' : 'activity'
                  setTab(next)
                  document.getElementById(tabId(next))?.focus()
                }}
                role="tab"
                tabIndex={tab === value ? 0 : -1}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="bot-profile-panel space-y-5" id={panelId('activity')} hidden={tab !== 'activity'} role="tabpanel" aria-labelledby={tabId('activity')}>
            {tab === 'activity' ? (
              <>
                <Section
                  action={(
                    <button
                      className="text-[12px] font-medium text-[var(--app-muted)] transition-colors hover:text-[var(--app-foreground)]"
                      onClick={() => onEditRoutine(null)}
                      type="button"
                    >
                      New routine
                    </button>
                  )}
                  id="bot-details-routines"
                  title="Upcoming"
                >
                  <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                    {routines.length ? routines.map((routine) => (
                      <div className="flex min-h-[52px] items-center gap-3 px-3 py-2" key={routine.id}>
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--app-active)] text-[var(--app-muted)]">
                          <Clock3 className="size-3.5" />
                        </span>
                        <button
                          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
                          onClick={() => onEditRoutine(routine)}
                          type="button"
                        >
                          <span className="block truncate text-[13px] font-medium leading-4 text-[var(--app-foreground)]">{routine.name}</span>
                          <span className="block truncate text-[12px] leading-4 text-[var(--app-muted)]">
                            {routine.isEnabled
                              ? `${routine.triggerDescription || routine.schedule}${routine.nextRunAt ? ` · ${formatRelative(routine.nextRunAt)}` : ''}`
                              : 'Paused'}
                          </span>
                        </button>
                        <DetailsToggle
                          checked={routine.isEnabled}
                          label={`${routine.isEnabled ? 'Disable' : 'Enable'} ${routine.name}`}
                          onChange={() => onToggleRoutine(routine, !routine.isEnabled)}
                        />
                      </div>
                    )) : (
                      <button
                        className="flex h-11 w-full items-center justify-center gap-2 px-3 text-[13px] text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
                        onClick={() => onEditRoutine(null)}
                        type="button"
                      >
                        <CalendarPlus className="size-4" />
                        No routines yet
                      </button>
                    )}
                  </div>
                </Section>
                <Section
                  action={<span className="text-[12px] leading-4 text-[var(--app-subtle-foreground)]">{computerState(bot)}</span>}
                  id="bot-details-computer"
                  title="Computer"
                >
                  {bot.kind === 'group' ? (
                    <EmptyCard>Not available for groups</EmptyCard>
                  ) : (
                    <div
                      aria-label={`Open ${bot.name}'s computer`}
                      className="group relative block aspect-video w-full cursor-pointer overflow-hidden rounded-lg border border-[var(--app-control-border)] bg-black text-left transition-colors hover:border-[var(--app-focus-ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
                      onClick={onOpenComputer}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onOpenComputer()
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <span className="pointer-events-none absolute inset-0 block">
                        <DesktopWorkbench
                          botId={bot.id}
                          loadingAvatar={{ color: bot.avatarColor, shape: bot.avatarShape, theme }}
                          loadingLabel="Waking up..."
                        />
                      </span>
                      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                      <span className="pointer-events-none absolute bottom-2 left-2 flex h-6 items-center gap-1.5 rounded-md bg-black/60 px-2 text-[12px] font-medium text-white backdrop-blur-sm">
                        Open computer
                      </span>
                    </div>
                  )}
                </Section>
                <details className="bot-profile-disclosure">
                  <summary>About and capabilities</summary>
                  <div className="space-y-5 px-3 pb-3 pt-1">
                    <Section id="bot-details-about" title="About">
                      <div className="overflow-hidden rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                        <div className="px-3.5 py-3">
                          <p className="text-[13px] leading-5 text-[var(--app-foreground)]">
                            {bot.description || 'No description yet. Add one so people know what this Bot is for.'}
                          </p>
                          {bot.instructions ? (
                            <blockquote className="mt-2.5 border-l-2 border-[var(--app-control-border)] pl-2.5 text-[12px] leading-5 text-[var(--app-muted)]">
                              {bot.instructions}
                            </blockquote>
                          ) : (
                            <p className="mt-2.5 text-[12px] leading-5 text-[var(--app-muted)]">
                              Focus is derived from this conversation, the workspace, and the apps on its computer.
                            </p>
                          )}
                        </div>
                        <div className="divide-y divide-[var(--app-border)] border-t border-[var(--app-border)]">
                          <InfoRow icon={<Cpu className="size-3.5" />} label="Model" value={bot.modelId || 'Workspace default'} />
                          <InfoRow icon={<Clock3 className="size-3.5" />} label="Created" value={formatDate(bot.createdAt)} />
                          <InfoRow icon={<Activity className="size-3.5" />} label="Status" value={status.label} />
                          <InfoRow icon={<Users className="size-3.5" />} label="Access" value={bot.kind === 'group' ? 'Group workspace' : 'Private to you'} />
                        </div>
                      </div>
                    </Section>
                    <div className="space-y-3">
                      <Section id="bot-details-skills" title="Skills">
                        <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                          {[
                            { icon: <Globe className="size-4" />, name: 'Web', detail: 'Search, read and automate pages in a real browser.' },
                            { icon: <Terminal className="size-4" />, name: 'Code & shell', detail: 'Read and edit files, run commands, build and test.' },
                            { icon: <Monitor className="size-4" />, name: 'Desktop', detail: 'Operate apps and windows on its own computer.' },
                            { icon: <MessageSquare className="size-4" />, name: 'Messaging', detail: 'Send a message when there is something worth saying.' },
                            { icon: <Users className="size-4" />, name: 'Team', detail: 'Hand a task to another Bot when it is a better fit.' },
                            { icon: <FileText className="size-4" />, name: 'Files', detail: 'Create documents, reports and previews in the workspace.' },
                          ].map((skill) => (
                            <div className="flex items-start gap-3 px-3 py-2.5" key={skill.name}>
                              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--app-active)] text-[var(--app-muted)]">
                                {skill.icon}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="text-[13px] font-medium leading-4 text-[var(--app-foreground)]">{skill.name}</p>
                                <p className="mt-0.5 text-[12px] leading-4 text-[var(--app-muted)]">{skill.detail}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Section>
                      <p className="px-0.5 text-[12px] leading-4 text-[var(--app-muted)]">
                        Skills are the capabilities this Bot can use while it works. The runtime exposes them to every turn.
                      </p>
                    </div>
                    <Section id="bot-details-channels" title="Channels">
                      <div className="flex items-start gap-3 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3.5 py-3">
                        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--app-active)] text-[13px] font-semibold text-[var(--app-muted)]">#</span>
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium leading-4 text-[var(--app-foreground)]">No channels connected</p>
                          <p className="mt-0.5 text-[12px] leading-4 text-[var(--app-muted)]">
                            Connect Slack or email so this Bot can receive work from outside this chat.
                          </p>
                        </div>
                      </div>
                    </Section>
                  </div>
                </details>
                <details className="bot-profile-disclosure" onToggle={(event) => setShowUsage(event.currentTarget.open)} open={showUsage}>
                  <summary>Usage and recent runs</summary>
                  <div className="px-3 pb-3 pt-1">
                    <div className="space-y-5">
                      {activityError ? (
                        <EmptyCard>{activityError}</EmptyCard>
                      ) : inspiration === null ? (
                        <div className="grid grid-cols-3 gap-2">
                          {[0, 1, 2].map((card) => (
                            <div className="h-[70px] animate-pulse rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]" key={card} />
                          ))}
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            {[
                              { label: 'Proactive runs', value: String(ledger.length) },
                              { label: 'Messages sent', value: String(proactiveMessages) },
                              { label: 'Spend today', value: formatUsd(proactiveSpend) },
                            ].map((stat) => (
                              <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 py-2.5" key={stat.label}>
                                <p className="truncate text-[11px] leading-4 text-[var(--app-muted)]">{stat.label}</p>
                                <p className="mt-0.5 truncate text-[16px] font-semibold leading-6 tracking-[-0.2px] text-[var(--app-foreground)]">{stat.value}</p>
                              </div>
                            ))}
                          </div>

                          <Section id="bot-details-proactive-summary" title="Proactive subscription">
                            <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                              <InfoRow
                                icon={<Clock3 className="size-3.5" />}
                                label="Next idea"
                                value={formatRelative(inspiration.nextFireAt)}
                              />
                              <InfoRow
                                icon={<Activity className="size-3.5" />}
                                label="Acted on"
                                value={`${acted.length} of ${ledger.length}`}
                              />
                              <InfoRow
                                icon={<Zap className="size-3.5" />}
                                label="Daily runs"
                                value={String(inspiration.usage.runs)}
                              />
                            </div>
                          </Section>

                          <Section id="bot-details-proactive-history" title="Recent proactive runs">
                            {latestRuns.length ? (
                              <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                                {latestRuns.map((record) => (
                                  <div className="px-3 py-2.5" key={record.id}>
                                    <div className="flex items-start gap-2">
                                      <span className={`mt-1 size-1.5 shrink-0 rounded-full ${
                                        record.outcome === 'acted'
                                          ? 'bg-emerald-500'
                                          : record.outcome === 'failed' || record.decision === 'error'
                                            ? 'bg-red-500'
                                            : 'bg-[var(--app-muted)]'
                                      }`} />
                                      <p className="min-w-0 flex-1 truncate text-[13px] leading-4 text-[var(--app-foreground)]">
                                        {record.candidate?.title || record.detail || record.decision}
                                      </p>
                                      <span className="shrink-0 text-[11px] leading-4 text-[var(--app-muted)]">{formatRelative(record.createdAt)}</span>
                                    </div>
                                    <p className="mt-1 pl-3.5 text-[11px] leading-4 text-[var(--app-muted)]">
                                      {record.decision}
                                      {record.outcome ? ` · ${record.outcome}` : ''}
                                      {record.messageCount ? ` · ${record.messageCount} message${record.messageCount === 1 ? '' : 's'}` : ''}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <EmptyCard>No proactive runs yet. Enable proactive messages to start tracking activity.</EmptyCard>
                            )}
                          </Section>

                          <Section id="bot-details-routine-activity" title="Routine activity">
                            <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                              {routines.length ? routines.slice(0, 4).map((routine) => (
                                <div className="flex items-center gap-3 px-3 py-2" key={routine.id}>
                                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--app-foreground)]">{routine.name}</span>
                                  <span className="shrink-0 text-[11px] leading-4 text-[var(--app-muted)]">
                                    {routine.lastRunAt ? `Last ${formatRelative(routine.lastRunAt)}` : 'Never run'}
                                  </span>
                                </div>
                              )) : (
                                <div className="px-3 py-3 text-[12px] leading-4 text-[var(--app-muted)]">No routines configured.</div>
                              )}
                            </div>
                          </Section>
                        </>
                      )}
                    </div>
                  </div>
                </details>
              </>
            ) : null}
          </div>
          <div className="bot-profile-panel space-y-5" id={panelId('library')} hidden={tab !== 'library'} role="tabpanel" aria-labelledby={tabId('library')}>
            {tab === 'library' ? (
              <>
                <div aria-label="Attachment type" className="bot-library-filters" role="group">
                  {LIBRARY_FILTERS.map(({ value, label }) => (
                    <button
                      aria-pressed={libraryFilter === value}
                      key={value}
                      onClick={() => {
                        setLibraryFilter(value)
                        setShowAllAttachments(false)
                      }}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Section id="bot-library-attachments" title="Shared in chat">
                  {visibleAttachments.length ? (
                    <div className="bot-library-list">
                      <ul>
                        {visibleAttachments.map((attachment) => (
                          <li key={attachment.id}>
                            <button onClick={() => onShowAttachment(attachment.id)} title={attachment.name} type="button">
                              {attachment.kind === 'media' ? <Image aria-hidden="true" /> : <FileText aria-hidden="true" />}
                              <span>{attachment.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      {attachments.length > INITIAL_ATTACHMENT_COUNT ? (
                        <button
                          aria-expanded={showAllAttachments}
                          className="bot-library-expand"
                          onClick={() => setShowAllAttachments((open) => !open)}
                          type="button"
                        >
                          {showAllAttachments ? 'Show fewer' : 'Show all'}
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <EmptyCard>{libraryFilter === 'media' ? 'No media shared yet.' : 'No files shared yet.'}</EmptyCard>
                  )}
                </Section>
                <div className="space-y-3" aria-live="polite">
                  <Section
                    action={memories?.length ? (
                      <button
                        className="text-[12px] font-medium text-[var(--app-muted)] transition-colors hover:text-[var(--app-danger)] disabled:opacity-40"
                        disabled={memoriesBusy}
                        onClick={() => { void clearMemories() }}
                        type="button"
                      >
                        Clear all
                      </button>
                    ) : null}
                    id="bot-details-memories"
                    title="Memories"
                  >
                    {memoriesBusy && memories === null ? (
                      <div className="space-y-2">
                        {[0, 1, 2].map((row) => (
                          <div className="h-[54px] animate-pulse rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]" key={row} />
                        ))}
                      </div>
                    ) : memoriesError ? (
                      <div className="rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-4 py-5 text-center">
                        <p className="text-[13px] leading-5 text-[var(--app-danger)]">{memoriesError}</p>
                        <button
                          className="mt-2 text-[12px] font-medium text-[var(--app-foreground)] underline underline-offset-2"
                          onClick={() => { void loadMemories() }}
                          type="button"
                        >
                          Try again
                        </button>
                      </div>
                    ) : memories?.length ? (
                      <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                        {memories.map((memory) => (
                          <div className="group flex items-start gap-2.5 px-3 py-2.5" key={memory.id}>
                            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--app-active)] text-[var(--app-muted)]">
                              <Brain className="size-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] leading-5 text-[var(--app-foreground)]">{memory.content}</p>
                              <p className="mt-0.5 text-[11px] leading-4 text-[var(--app-muted)]">
                                {memory.kind === 'profile' ? 'Profile' : 'Log'}
                                {memory.createdAt ? ` · ${formatDate(new Date(memory.createdAt).toISOString())}` : ''}
                              </p>
                            </div>
                            <button
                              aria-label="Forget this memory"
                              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] opacity-0 transition-opacity hover:bg-[var(--app-hover)] hover:text-[var(--app-danger)] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                              onClick={() => { void removeMemory(memory.id) }}
                              title="Forget this memory"
                              type="button"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyCard>
                        Nothing remembered yet. As you work together, facts worth keeping will appear here.
                      </EmptyCard>
                    )}
                  </Section>
                  <p className="px-0.5 text-[12px] leading-4 text-[var(--app-muted)]">
                    Memories are facts the Bot keeps across conversations. Removing one does not delete the transcript.
                  </p>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  )
}
