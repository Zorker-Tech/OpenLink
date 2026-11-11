import { MicIcon, PlusIcon } from './icons'

export function Composer({ agentName }: { agentName: string }) {
  return (
    <div className="zbd-composer-wrap">
      <div aria-hidden="true" className="zbd-composer-fade" />
      <div className="zbd-composer">
        <span className="zbd-composer-plus">
          <PlusIcon size={16} />
        </span>
        <div className="zbd-composer-field" data-zbd-target="composer-field">
          <span className="zbd-composer-placeholder">Message {agentName}</span>
        </div>
        <button aria-label="Voice message" className="zbd-composer-send" tabIndex={-1} type="button">
          <MicIcon size={15} />
        </button>
      </div>
    </div>
  )
}
