import { useLayoutEffect, useRef, useState } from 'react'
import type { ScriptedScreen, ScreenOverlayState } from '../types'
import { CloseIcon } from './icons'
import { ScreenFrame } from './ScreenFrame'

export type ScreenOverlayProps = {
  overlay: ScreenOverlayState
  screen: ScriptedScreen
  rootWidth: number
  rootHeight: number
  assetBase: string
  onClose: () => void
  onFinish: () => void
}

export function ScreenOverlay({
  overlay,
  screen,
  rootWidth,
  rootHeight,
  assetBase,
  onClose,
  onFinish,
}: ScreenOverlayProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [animated, setAnimated] = useState(false)
  const [from, setFrom] = useState<{ x: number; y: number; scale: number } | null>(null)
  const takeover = overlay.mode === 'takeover'
  const frameHeight = takeover
    ? Math.min(rootHeight - 118, rootWidth * 0.625 - 50, 494)
    : Math.min(rootHeight - 72, rootWidth * 0.625 - 45, 512)
  const frameWidth = frameHeight * 1.6

  useLayoutEffect(() => {
    const frame = frameRef.current
    const thumb = document.querySelector<HTMLElement>('[data-zbd-thumb="computer"]')
    if (!frame || !thumb) {
      setAnimated(true)
      return
    }

    const frameRect = frame.getBoundingClientRect()
    const thumbRect = thumb.getBoundingClientRect()
    setFrom({
      x: thumbRect.left - frameRect.left,
      y: thumbRect.top - frameRect.top,
      scale: thumbRect.width / frameRect.width,
    })
    const raf = requestAnimationFrame(() => setAnimated(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const flipStyle = {
    transform: !animated && from
      ? `translate(${from.x}px, ${from.y}px) scale(${from.scale})`
      : 'none',
    transformOrigin: 'top left',
    transition: animated ? 'transform .45s cubic-bezier(.22,1,.36,1)' : 'none',
  }

  return (
    <div className="zbd-screen-layer">
      <button
        aria-label="Close screen"
        className="zbd-screen-scrim"
        onClick={onClose}
        style={{ opacity: animated ? 1 : 0 }}
        type="button"
      />
      {takeover ? (
        <div
          className="zbd-screen-shell"
          style={{ width: frameWidth + 24, height: frameHeight + 62 }}
        >
          <div
            className="zbd-screen-surface"
            style={{ opacity: animated ? 1 : 0, transition: 'opacity .2s ease .5s' }}
          />
          <div
            className="zbd-screen-banner"
            style={{ opacity: animated ? 1 : 0, transition: 'opacity .2s ease .5s' }}
          >
            <span className="zbd-screen-banner-label">
              {overlay.instruction ?? 'You’re in control'}
            </span>
            <button
              className="zbd-screen-banner-done"
              data-zbd-target="screen-done"
              onClick={onFinish}
              type="button"
            >
              I’m done, continue
            </button>
          </div>
          <div className="zbd-screen-frame-slot" style={flipStyle}>
            <ScreenFrame assetBase={assetBase} frameRef={frameRef} height={frameHeight} screen={screen} />
          </div>
        </div>
      ) : (
        <div className="zbd-screen-frame-slot zbd-screen-frame-slot-lightbox" style={flipStyle}>
          <ScreenFrame assetBase={assetBase} frameRef={frameRef} height={frameHeight} screen={screen} />
          <button aria-label="Close screen" className="zbd-screen-close" onClick={onClose} type="button">
            <CloseIcon size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
