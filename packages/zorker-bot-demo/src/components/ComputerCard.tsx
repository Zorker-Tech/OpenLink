import { RemoteDesktop } from '../remote-desktop/RemoteDesktop'
import type { ComputerStatus, ScriptedScreen, TranscriptEntry } from '../types'
import { ComputerBadge } from './ComputerBadge'

export type ComputerCardProps = {
  entry: Extract<TranscriptEntry, { kind: 'computer' }>
  status: ComputerStatus
  screen: ScriptedScreen
  assetBase: string
  onOpen: () => void
  onTakeOver: () => void
  onFinish: () => void
}

export function ComputerCard({
  entry,
  status,
  screen,
  assetBase,
  onOpen,
  onTakeOver,
  onFinish,
}: ComputerCardProps) {
  const isActionable = status === 'action-needed' || status === 'handed-over'
  const view = isActionable ? 'login' : 'portal'

  return (
    <div className="zbd-card-wrap">
      <div className="zbd-card">
        <div className="zbd-card-head">
          <button className="zbd-card-title" onClick={onOpen} type="button">Computer</button>
          <span className="zbd-spacer" />
          <ComputerBadge status={status} />
        </div>
        <p className="zbd-card-instruction">{entry.instruction}</p>
        <div
          aria-label="Open Sales Outbound's computer"
          className="zbd-card-thumb"
          data-zbd-thumb="computer"
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen()
            }
          }}
          role="button"
          tabIndex={0}
        >
          <RemoteDesktop
            agentCursor={status === 'working'}
            assetBase={assetBase}
            emailChars={screen.emailChars}
            focus={screen.focus}
            passwordChars={screen.passwordChars}
            showDock={false}
            view={view}
          />
        </div>
        {isActionable ? (
          <div className="zbd-card-actions">
            <button
              className="zbd-card-action"
              data-zbd-target="computer-take-over"
              data-variant="primary"
              onClick={onTakeOver}
              type="button"
            >
              Take over
            </button>
            <button className="zbd-card-action" data-variant="secondary" onClick={onFinish} type="button">
              I’m done
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
