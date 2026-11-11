import type { Ref } from 'react'
import { RemoteDesktop } from '../remote-desktop/RemoteDesktop'
import type { ScriptedScreen } from '../types'

export type ScreenFrameProps = {
  assetBase: string
  screen: ScriptedScreen
  height: number
  className?: string
  frameRef?: Ref<HTMLDivElement>
}

export function ScreenFrame({
  assetBase,
  screen,
  height,
  className,
  frameRef,
}: ScreenFrameProps) {
  return (
    <div
      aria-label="Sales Outbound's screen"
      aria-modal="true"
      className={`zbd-screen-frame ${className ?? ''}`}
      ref={frameRef}
      role="dialog"
      style={{ height, width: height * 1.6 }}
    >
      <RemoteDesktop
        agentCursor={screen.isWorking}
        assetBase={assetBase}
        emailChars={screen.emailChars}
        focus={screen.focus}
        passwordChars={screen.passwordChars}
        showDock
        view={screen.view}
      />
    </div>
  )
}
