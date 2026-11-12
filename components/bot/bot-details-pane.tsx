'use client'

import { AgentAvatar } from '@zorker/avatar'
import type { BotSummary } from '@/lib/bot-types'
import { Monitor, Settings2, X } from 'lucide-react'

type BotDetailsPaneProps = {
  bot: BotSummary
  theme: 'light' | 'dark'
  onClose: () => void
  onEditProfile: () => void
  onOpenComputer: () => void
}

function computerState(bot: BotSummary) {
  if (bot.kind === 'group') return 'Not available'
  if (bot.runtimeStatus === 'ready') return 'Online'
  if (bot.runtimeStatus === 'failed') return 'Offline'
  return 'Starting'
}

/**
 * The Bot identity and computer panel opened from the chat capsule. Editing
 * the profile remains in the existing dialog; this panel only surfaces the
 * current state and the computer entry point.
 */
export function BotDetailsPane({
  bot,
  theme,
  onClose,
  onEditProfile,
  onOpenComputer,
}: BotDetailsPaneProps) {
  return (
    <aside aria-label={`${bot.name} details`} className="zbd-side-pane zbd-app-computer-pane w-[360px]!">
      <div className="zbd-side-pane-inner">
        <header className="zbd-side-pane-header justify-between! px-4!">
          <span className="text-[12px] font-medium text-[var(--app-muted)]">Bot details</span>
          <button
            aria-label="Close details"
            className="zbd-window-action"
            onClick={onClose}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </header>

        <div className="zbd-side-pane-scroll">
          <div className="flex flex-col items-center pt-2 text-center">
            <AgentAvatar
              color={bot.avatarColor}
              renderer="complete"
              shape={bot.avatarShape}
              size={96}
              state="idle"
              theme={theme}
            />
            <div className="mt-3 flex min-w-0 max-w-full items-center gap-1.5">
              <span className="truncate text-[18px] font-medium tracking-[-0.02em]">{bot.name}</span>
              <button
                aria-label="Edit profile"
                className="zbd-window-action"
                onClick={onEditProfile}
                title="Edit profile"
                type="button"
              >
                <Settings2 className="size-3.5" />
              </button>
            </div>
            <div className="mt-3 inline-flex gap-1 rounded-full bg-[var(--app-active)] p-1 text-[12px]">
              <button aria-pressed="true" className="rounded-full bg-[var(--app-surface)] px-3 py-1 font-medium text-[var(--app-foreground)] shadow-sm" type="button">
                Activity
              </button>
              <button aria-pressed="false" className="rounded-full px-3 py-1 text-[var(--app-muted)]" type="button">
                Library
              </button>
            </div>
          </div>

          <div className="zbd-side-section-title">Computer</div>
          <button
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-hover)] disabled:pointer-events-none disabled:opacity-50"
            disabled={bot.kind === 'group'}
            onClick={onOpenComputer}
            type="button"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-active)] text-[var(--app-muted)]">
              <Monitor className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{bot.name}&apos;s computer</span>
              <span className="block text-[11px] text-[var(--app-muted)]">{computerState(bot)}</span>
            </span>
          </button>

          <div className="zbd-side-section-title">Voice chat</div>
          <div className="divide-y divide-[var(--app-border)] rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] px-3 text-[12px]">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-[var(--app-muted)]">Voice</span>
              <span>Standard 1.0x</span>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-[var(--app-muted)]">Language</span>
              <span>Auto-detect</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
