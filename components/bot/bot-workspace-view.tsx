'use client'

import { DesktopWorkbench } from '@/components/browser/desktop-workbench'
import { PaneResizeHandle, usePaneResize } from '@/components/bot/bot-pane-resize'

type BotWorkspaceViewProps = {
  botName: string
  botId: string
  avatarColor: string
  avatarShape: string
  theme: 'light' | 'dark'
  onClose: () => void
}

/**
 * The Bot computer owns the full right-hand surface. Its title doubles as the
 * only chrome; the running desktop itself is inset into a rounded canvas.
 */
export function BotWorkspaceView({
  botName,
  botId,
  avatarColor,
  avatarShape,
  theme,
  onClose,
}: BotWorkspaceViewProps) {
  const pane = usePaneResize({
    defaultWidth: 560,
    minWidth: 380,
    maxWidth: 960,
    storageKey: 'openlink-bot-workspace-width',
  })

  return (
    <aside
      aria-label={`${botName} workspace`}
      className="zbd-side-pane zbd-app-computer-pane relative shrink-0"
      style={{ width: pane.width }}
    >
      <PaneResizeHandle
        maxWidth={960}
        minWidth={380}
        onNudge={pane.nudge}
        onPointerDown={pane.beginResize}
        resizing={pane.resizing}
        width={pane.width}
      />
      <div className="zbd-side-pane-inner">
        <header className="relative flex h-11 shrink-0 items-center justify-center bg-[var(--app-background)] px-3">
          <h1 className="max-w-[calc(100%-72px)] truncate text-[11px] font-semibold tracking-[-0.05px] text-[var(--app-foreground)]">
            {botName}&apos;s computer
          </h1>
          <button
            aria-label="Close computer"
            className="zbd-window-action absolute right-3 opacity-0 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:hover:opacity-100"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden className="text-[16px] leading-none">×</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 px-3.5 pb-5">
          <div className="size-full overflow-hidden rounded-xl bg-[var(--app-active)]">
            <DesktopWorkbench
              botId={botId}
              loadingAvatar={{ color: avatarColor, shape: avatarShape, theme }}
              loadingLabel="Waking up..."
            />
          </div>
        </div>
      </div>
    </aside>
  )
}
