'use client'

import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import { Globe2, Monitor, X } from 'lucide-react'
import { useState } from 'react'

type BotWorkspaceTab = 'realtime' | 'desktop'

type BotWorkspaceViewProps = {
  botName: string
  botId: string
  onClose: () => void
}

/**
 * The Bot computer uses the same right-side workspace structure as a Code
 * session: a tab strip above a full-height surface. Only the live browser and
 * desktop surfaces belong to a Bot; the Code-only tabs and publish actions are
 * intentionally absent.
 */
export function BotWorkspaceView({ botName, botId, onClose }: BotWorkspaceViewProps) {
  const [tab, setTab] = useState<BotWorkspaceTab>('desktop')

  return (
    <aside
      aria-label={`${botName} workspace`}
      className="zbd-side-pane zbd-app-computer-pane w-[min(760px,55vw)]! min-w-[380px]!"
    >
      <div className="zbd-side-pane-inner">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--app-border)] px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="Bot workspace">
            <button
              aria-selected={tab === 'realtime'}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors"
              onClick={() => setTab('realtime')}
              style={{
                background: tab === 'realtime' ? 'var(--app-active)' : 'transparent',
                color: tab === 'realtime' ? 'var(--app-foreground)' : 'var(--app-muted)',
              }}
              role="tab"
              type="button"
            >
              <Globe2 className="size-3.5" />
              Live Browser
            </button>
            <button
              aria-selected={tab === 'desktop'}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors"
              onClick={() => setTab('desktop')}
              style={{
                background: tab === 'desktop' ? 'var(--app-active)' : 'transparent',
                color: tab === 'desktop' ? 'var(--app-foreground)' : 'var(--app-muted)',
              }}
              role="tab"
              type="button"
            >
              <Monitor className="size-3.5" />
              Desktop
            </button>
          </div>
          <button
            aria-label="Close workspace"
            className="zbd-window-action shrink-0"
            onClick={onClose}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          <div aria-hidden={tab !== 'desktop'} className={`absolute inset-0 ${tab === 'desktop' ? 'visible' : 'invisible pointer-events-none'}`}>
            <DesktopWorkbench botId={botId} />
          </div>
          <div aria-hidden={tab !== 'realtime'} className={`absolute inset-0 ${tab === 'realtime' ? 'visible' : 'invisible pointer-events-none'}`}>
            <div className="flex size-full flex-col items-center justify-center gap-3 bg-[var(--app-background)] px-8 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-[var(--app-active)] text-[var(--app-muted)]">
                <Globe2 className="size-5" />
              </span>
              <div>
                <p className="text-[13px] font-medium">Live Browser</p>
                <p className="mt-1 max-w-[320px] text-[12px] leading-5 text-[var(--app-muted)]">
                  The Bot browser is part of its desktop. Open the Desktop tab to watch or take over the running session.
                </p>
              </div>
              <button
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-3 text-[12px] hover:bg-[var(--app-active)]"
                onClick={() => setTab('desktop')}
                type="button"
              >
                <Monitor className="size-3.5" />
                Open Desktop
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
