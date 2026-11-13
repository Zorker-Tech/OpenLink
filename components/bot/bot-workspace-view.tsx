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

const BOT_WORKSPACE_TABS: ReadonlyArray<{ id: BotWorkspaceTab; label: string; icon: typeof Globe2 }> = [
  { id: 'realtime', label: 'Live Browser', icon: Globe2 },
  { id: 'desktop', label: 'Desktop', icon: Monitor },
]

/**
 * Tab geometry shared with the Code workspace so the two surfaces read as one
 * system: 28px tall, 112–126px wide, 8px radius, inset control border.
 */
function tabClassName(selected: boolean): string {
  return `mr-0.5 flex h-7 min-w-[112px] max-w-[126px] shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-2 text-[13px] font-medium tracking-[-0.0762px] transition-[background-color,color,box-shadow] duration-150 ${
    selected
      ? 'bg-[var(--app-active)]! text-[var(--app-foreground)] shadow-[inset_0_0_0_1px_var(--app-control-border),0_1px_2px_var(--app-shadow)]'
      : 'bg-[var(--app-surface)]! text-[var(--app-muted)] shadow-[inset_0_0_0_1px_var(--app-control-border)] hover:bg-[var(--app-hover)]! hover:text-[var(--app-foreground)]'
  }`
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
        <header className="flex h-11 shrink-0 items-center border-b border-[var(--app-border)] bg-[var(--app-background)] px-2.5">
          <div aria-label="Bot workspace" className="flex h-7 min-w-0 flex-1 items-center overflow-hidden" role="tablist">
            <div className="flex min-w-0 items-center overflow-x-auto pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {BOT_WORKSPACE_TABS.map(({ id, label, icon: Icon }) => {
                const selected = tab === id
                return (
                  <button
                    aria-controls={`bot-workspace-panel-${id}`}
                    aria-selected={selected}
                    className={tabClassName(selected)}
                    id={`bot-workspace-tab-${id}`}
                    key={id}
                    onClick={() => setTab(id)}
                    role="tab"
                    type="button"
                  >
                    <Icon aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <button
            aria-label="Close workspace"
            className="zbd-window-action ml-1 shrink-0"
            onClick={onClose}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            aria-hidden={tab !== 'desktop'}
            aria-labelledby="bot-workspace-tab-desktop"
            className={`absolute inset-0 ${tab === 'desktop' ? 'visible' : 'invisible pointer-events-none'}`}
            id="bot-workspace-panel-desktop"
            role="tabpanel"
          >
            <DesktopWorkbench botId={botId} />
          </div>
          <div
            aria-hidden={tab !== 'realtime'}
            aria-labelledby="bot-workspace-tab-realtime"
            className={`absolute inset-0 ${tab === 'realtime' ? 'visible' : 'invisible pointer-events-none'}`}
            id="bot-workspace-panel-realtime"
            role="tabpanel"
          >
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
