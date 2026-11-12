'use client'

import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import { Monitor, X } from 'lucide-react'
import { useEffect } from 'react'

type BotComputerProps = {
  botName: string
  chatSessionId: string
  onClose: () => void
}

export function BotComputerPane({ botName, chatSessionId, onClose }: BotComputerProps) {
  return (
    <aside aria-label={`${botName}'s computer`} className="zbd-side-pane zbd-app-computer-pane">
      <div className="flex h-full min-h-0 flex-col">
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
        <div className="min-h-0 flex-1 overflow-hidden">
          <DesktopWorkbench chatSessionId={chatSessionId} />
        </div>
      </div>
    </aside>
  )
}

export function BotComputerLightbox({ botName, chatSessionId, onClose }: BotComputerProps) {
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
        <DesktopWorkbench chatSessionId={chatSessionId} />
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
