import { useEffect } from 'react'
import { CloseIcon } from '../components/icons'
import { DesktopPreview } from './DesktopPreview'

export type AppScreenLightboxProps = {
  assetBase: string
  displayName: string
  onClose: () => void
}

export function AppScreenLightbox({
  assetBase,
  displayName,
  onClose,
}: AppScreenLightboxProps) {
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
        aria-label={`${displayName}'s screen`}
        aria-modal="true"
        className="zbd-app-lightbox-panel"
        role="dialog"
      >
        <DesktopPreview assetBase={assetBase} />
        <button
          aria-label="Close screen"
          className="zbd-screen-close"
          onClick={onClose}
          type="button"
        >
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  )
}
