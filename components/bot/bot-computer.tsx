'use client'

import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import type { BotRoutine } from '@/lib/bot-types'
import { Clock, Monitor, Play, X } from 'lucide-react'
import { useEffect } from 'react'

type BotComputerProps = {
  botName: string
  botId: string
  onClose: () => void
}

type BotComputerPaneProps = BotComputerProps & {
  routines: readonly BotRoutine[]
  onEditRoutine: (routine: BotRoutine | null) => void
  onRunRoutine: (routine: BotRoutine) => void
  onToggleRoutine: (routine: BotRoutine, isEnabled: boolean) => void
}

export function BotComputerPane({
  botName,
  botId,
  onClose,
  onEditRoutine,
  onRunRoutine,
  onToggleRoutine,
  routines,
}: BotComputerPaneProps) {
  return (
    <aside aria-label={`${botName}'s computer`} className="zbd-side-pane zbd-app-computer-pane">
      <div className="zbd-side-pane-inner">
        <header className="zbd-side-pane-header">
          <span className="flex min-w-0 items-center gap-2 px-2 text-[12px] font-medium text-[var(--app-muted)]">
            <Monitor className="size-3.5" />
            <span className="truncate">{botName}&apos;s computer</span>
          </span>
          <button
            aria-label="Close computer"
            className="zbd-window-action"
            onClick={onClose}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </header>
        <div className="zbd-side-pane-scroll">
          <div className="h-[220px] overflow-hidden rounded-[10px] border border-[var(--app-border)] bg-[var(--app-surface)]">
            <DesktopWorkbench botId={botId} />
          </div>
          <div className="zbd-side-screen-label">{botName}&apos;s screen</div>
          <div className="zbd-side-section-title">Routines</div>
          {routines.length ? (
            routines.map((routine) => (
              <div className="zbd-routine-row zbd-app-routine-row" key={routine.id}>
                <span className="zbd-routine-icon"><Clock className="size-3.5" /></span>
                <span className="zbd-routine-copy min-w-0 flex-1">
                  <button className="truncate text-left hover:underline" onClick={() => onEditRoutine(routine)} type="button">
                    {routine.name}
                  </button>
                  <span className="truncate">{routine.triggerDescription || routine.schedule}</span>
                </span>
                <button
                  aria-label={`Run ${routine.name}`}
                  className="zbd-window-action"
                  onClick={() => onRunRoutine(routine)}
                  title="Run now"
                  type="button"
                >
                  <Play className="size-3" />
                </button>
                <button
                  aria-checked={routine.isEnabled}
                  aria-label={`${routine.isEnabled ? 'Disable' : 'Enable'} ${routine.name}`}
                  className="zbd-window-action"
                  onClick={() => onToggleRoutine(routine, !routine.isEnabled)}
                  role="switch"
                  title={routine.isEnabled ? 'Disable routine' : 'Enable routine'}
                  type="button"
                >
                  <span className="zbd-app-switch" data-on={routine.isEnabled ? '' : undefined}><span /></span>
                </button>
              </div>
            ))
          ) : (
            <button className="zbd-app-routine-empty w-full" onClick={() => onEditRoutine(null)} type="button">
              Nothing scheduled yet. Create a routine to have {botName} work on a schedule.
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

export function BotComputerLightbox({ botName, botId, onClose }: BotComputerProps) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])

  return (
    <div className="zbd-app-lightbox">
      <button
        aria-label="Close screen"
        className="zbd-app-lightbox-scrim"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label={`${botName}'s screen`}
        aria-modal="true"
        className="zbd-app-lightbox-panel"
        role="dialog"
      >
        <DesktopWorkbench botId={botId} />
        <button
          aria-label="Close screen"
          className="zbd-screen-close"
          onClick={onClose}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
