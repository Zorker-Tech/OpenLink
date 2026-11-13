'use client'

import { AgentAvatar } from '@zorker/avatar'
import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import { PaneResizeHandle, usePaneResize } from '@/components/bot/bot-pane-resize'
import type { BotRoutine, BotSummary } from '@/lib/bot-types'
import { CalendarPlus, X } from 'lucide-react'
import { useState } from 'react'

type BotDetailsPaneProps = {
  bot: BotSummary
  theme: 'light' | 'dark'
  routines: readonly BotRoutine[]
  onClose: () => void
  onEditProfile: () => void
  onEditRoutine: (routine: BotRoutine | null) => void
  onOpenComputer: () => void
  onToggleRoutine: (routine: BotRoutine, isEnabled: boolean) => void
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
      className="relative flex h-[18px] w-[30px] shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)] disabled:opacity-40"
      disabled={disabled}
      onClick={onChange}
      role="switch"
      style={{ background: checked ? 'var(--app-submit-background)' : 'color-mix(in srgb, var(--app-foreground) 12%, transparent)' }}
      type="button"
    >
      <span
        aria-hidden
        className="size-[14px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.22)] transition-transform"
        style={{ transform: checked ? 'translateX(14px)' : 'translateX(2px)' }}
      />
    </button>
  )
}

/**
 * A wide, centered details surface. It deliberately stays inside the existing
 * side-pane primitive so opening it never moves or resizes the chat itself.
 */
export function BotDetailsPane({
  bot,
  theme,
  routines,
  onClose,
  onEditProfile,
  onEditRoutine,
  onOpenComputer,
  onToggleRoutine,
}: BotDetailsPaneProps) {
  const [tab, setTab] = useState<'details' | 'library'>('details')
  const pane = usePaneResize({
    defaultWidth: 420,
    minWidth: 320,
    maxWidth: 720,
    storageKey: 'openlink-bot-details-width',
  })
  const tabId = (value: 'details' | 'library') => `bot-details-tab-${value}`
  const panelId = (value: 'details' | 'library') => `bot-details-panel-${value}`

  return (
    <aside
      aria-label={`${bot.name} details`}
      className="zbd-side-pane zbd-app-computer-pane relative shrink-0"
      style={{ width: pane.width }}
    >
      <PaneResizeHandle
        maxWidth={720}
        minWidth={320}
        onNudge={pane.nudge}
        onPointerDown={pane.beginResize}
        resizing={pane.resizing}
        width={pane.width}
      />
      <div className="zbd-side-pane-inner">
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <button aria-label="Close details" className="zbd-window-action absolute right-3 top-2.5 z-10" onClick={onClose} type="button">
            <X className="size-3.5" />
          </button>

          <div className="mx-auto flex w-full max-w-[912px] flex-col items-center px-5 pb-10 pt-[50px]">
            <button
              aria-label="Edit Bot profile"
              className="rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
              onClick={onEditProfile}
              type="button"
            >
              <AgentAvatar
                color={bot.avatarColor}
                renderer="complete"
                shape={bot.avatarShape}
                size={48}
                state="idle"
                theme={theme}
              />
            </button>
            <h1 className="mt-3 max-w-full truncate text-[12px] font-medium tracking-[-0.05px] text-[var(--app-foreground)]">{bot.name}</h1>

            <div
              aria-label="Bot details views"
              className="mt-4 inline-flex items-center gap-1 rounded-lg bg-[var(--app-active)] p-1 text-[12px] leading-4"
              role="tablist"
            >
              {(['details', 'library'] as const).map((value) => {
                const selected = tab === value
                return (
                  <button
                    aria-controls={selected ? panelId(value) : undefined}
                    aria-selected={selected}
                    className={`h-6 rounded-md px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)] ${
                      selected
                        ? 'bg-[var(--app-surface)] text-[var(--app-foreground)] shadow-[0_1px_2px_var(--app-shadow)]'
                        : 'text-[var(--app-muted)] hover:text-[var(--app-foreground)]'
                    }`}
                    id={tabId(value)}
                    key={value}
                    onClick={() => setTab(value)}
                    role="tab"
                    type="button"
                  >
                    {value === 'details' ? 'Details' : 'Library'}
                  </button>
                )
              })}
            </div>

            <div className="mt-5 w-full" id={panelId(tab)} role="tabpanel" aria-labelledby={tabId(tab)}>
              {tab === 'details' ? (
                <div className="space-y-5">
                  <section aria-labelledby="bot-details-suggested">
                    <h2 className="mb-2 px-0.5 text-[12px] leading-4 text-[var(--app-muted)]" id="bot-details-suggested">Suggested</h2>
                    <button
                      className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] text-[12px] font-medium text-[var(--app-foreground)] transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
                      disabled
                      title="Meetings are not available yet"
                      type="button"
                    >
                      <CalendarPlus className="size-4" />
                      Add to meeting
                    </button>
                  </section>

                  <section aria-labelledby="bot-details-routines">
                    <h2 className="mb-2 px-0.5 text-[12px] leading-4 text-[var(--app-muted)]" id="bot-details-routines">Routines</h2>
                    <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                      {routines.length ? routines.map((routine) => (
                        <div className="flex min-h-[44px] items-center gap-3 px-3 py-2" key={routine.id}>
                          <button
                            className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
                            onClick={() => onEditRoutine(routine)}
                            type="button"
                          >
                            <span className="block truncate text-[12px] font-medium leading-4 text-[var(--app-foreground)]">{routine.name}</span>
                            <span className="block truncate text-[11px] leading-4 text-[var(--app-muted)]">
                              {routine.isEnabled ? (routine.triggerDescription || routine.schedule) : 'Paused'}
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
                          className="flex h-11 w-full items-center justify-center gap-2 px-3 text-[12px] text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
                          onClick={() => onEditRoutine(null)}
                          type="button"
                        >
                          <CalendarPlus className="size-4" />
                          No routines yet
                        </button>
                      )}
                    </div>
                  </section>

                  <section aria-labelledby="bot-details-computer">
                    <div className="mb-2 flex items-center justify-between px-0.5">
                      <h2 className="text-[12px] leading-4 text-[var(--app-muted)]" id="bot-details-computer">Computer</h2>
                      <span className="text-[11px] leading-4 text-[var(--app-subtle-foreground)]">{computerState(bot)}</span>
                    </div>
                    {bot.kind === 'group' ? (
                      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] text-[12px] text-[var(--app-muted)]">
                        Not available for groups
                      </div>
                    ) : (
                      <button
                        aria-label={`Open ${bot.name}'s computer`}
                        className="group relative block aspect-video w-full overflow-hidden rounded-lg border border-[var(--app-control-border)] bg-black text-left transition-colors hover:border-[var(--app-focus-ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
                        onClick={onOpenComputer}
                        type="button"
                      >
                        <span className="pointer-events-none absolute inset-0 block">
                          <DesktopWorkbench
                            botId={bot.id}
                            loadingAvatar={{ color: bot.avatarColor, shape: bot.avatarShape, theme }}
                            loadingLabel="Waking up..."
                          />
                        </span>
                        <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                        <span className="pointer-events-none absolute bottom-2 left-2 flex h-6 items-center gap-1.5 rounded-md bg-black/60 px-2 text-[11px] font-medium text-white backdrop-blur-sm">
                          Open computer
                        </span>
                      </button>
                    )}
                  </section>

                  <section aria-labelledby="bot-details-voice">
                    <h2 className="mb-2 px-0.5 text-[12px] leading-4 text-[var(--app-muted)]" id="bot-details-voice">Voice chat</h2>
                    <div className="divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)]">
                      {[
                        ['Voice', 'Liora'],
                        ['Speed', '1x'],
                        ['Language', 'Auto-detect'],
                      ].map(([label, value]) => (
                        <div className="flex h-7 items-center justify-between gap-4 px-3" key={label}>
                          <span className="text-[12px] text-[var(--app-foreground)]">{label}</span>
                          <span className="rounded border border-[var(--app-control-border)] px-1.5 py-0.5 text-[11px] leading-4 text-[var(--app-foreground)]">{value}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="flex min-h-[180px] flex-col items-center justify-center rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-6 text-center">
                  <p className="text-[12px] font-medium text-[var(--app-foreground)]">Library</p>
                  <p className="mt-1 max-w-[320px] text-[12px] leading-5 text-[var(--app-muted)]">Files and artifacts from this Bot will appear here.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
