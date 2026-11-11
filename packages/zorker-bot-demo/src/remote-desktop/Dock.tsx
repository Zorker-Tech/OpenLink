import { SafariIcon } from '../components/icons'

export function Dock() {
  return (
    <div className="zbd-rd-dock-wrap">
      <div aria-label="Applications" className="zbd-rd-dock" role="toolbar">
        <button
          aria-label="Hide CRM portal"
          className="zbd-rd-dock-item"
          data-visible="true"
          tabIndex={-1}
          type="button"
        >
          <span className="zbd-rd-dock-icon">
            <SafariIcon size={22} />
          </span>
          <span aria-hidden="true" className="zbd-rd-dock-indicator" />
        </button>
      </div>
    </div>
  )
}
