import { ROUTINE } from '../data/copy'
import { RemoteDesktop } from '../remote-desktop/RemoteDesktop'
import type { ScriptedScreen } from '../types'
import { ClockIcon, CloseIcon, GearIcon } from './icons'

export type SidePaneProps = {
  assetBase: string
  screen: ScriptedScreen
  onClose: () => void
  onOpenScreen: () => void
}

export function SidePane({
  assetBase,
  screen,
  onClose,
  onOpenScreen,
}: SidePaneProps) {
  return (
    <aside className="zbd-side-pane">
      <div className="zbd-side-pane-inner">
        <header className="zbd-side-pane-header">
          <button aria-label="Agent settings" className="zbd-window-action" type="button">
            <GearIcon size={15} />
          </button>
          <button aria-label="Close computer" className="zbd-window-action" onClick={onClose} type="button">
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="zbd-side-pane-scroll">
          <button className="zbd-side-preview" onClick={onOpenScreen} type="button">
            <RemoteDesktop
              assetBase={assetBase}
              emailChars={screen.emailChars}
              focus={screen.focus}
              passwordChars={screen.passwordChars}
              showDock={false}
              view={screen.view}
            />
          </button>
          <div className="zbd-side-screen-label">Sales Outbound’s screen</div>
          <div className="zbd-side-section-title">Routines</div>
          <div className="zbd-routine-row">
            <span className="zbd-routine-icon">
              <ClockIcon size={15} />
            </span>
            <span className="zbd-routine-copy">
              <span>{ROUTINE.name}</span>
              <span>{ROUTINE.triggerDescription}</span>
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}
