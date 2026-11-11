'use client'

import type { CSSProperties } from 'react'
import type { ScreenView } from '../types'
import { Dock } from './Dock'
import { LoginView } from './LoginView'
import { PortalView } from './PortalView'
import { useDesktopScale } from './useDesktopScale'

export type RemoteDesktopProps = {
  assetBase: string
  view: ScreenView
  emailChars?: number
  passwordChars?: number
  focus?: 'email' | 'password' | null
  showDock?: boolean
  agentCursor?: boolean
  className?: string
}

export function RemoteDesktop({
  assetBase,
  view,
  emailChars = 0,
  passwordChars = 0,
  focus = null,
  showDock = true,
  agentCursor = false,
  className,
}: RemoteDesktopProps) {
  const { ref, scale } = useDesktopScale<HTMLDivElement>()

  return (
    <div
      className={`zbd-rd ${className ?? ''}`}
      ref={ref}
      style={{ ['--rd-scale' as string]: scale } as CSSProperties}
    >
      <img alt="" className="zbd-rd-wallpaper" draggable={false} src={`${assetBase}/wallpaper-light.webp`} />
      <div className="zbd-rd-window">
        <div
          className="zbd-rd-window-inner"
          style={{
            width: 'calc(360px * 0.5)',
            height: 'calc(225px * 0.72)',
            transform: `scale(${scale})`,
          }}
        >
          <div className="zbd-rd-titlebar">
            <span />
            <span />
            <span />
          </div>
          <div aria-hidden="true" className="zbd-rd-addressbar">
            <span />
          </div>
          {view === 'login' ? (
            <LoginView emailChars={emailChars} focus={focus} passwordChars={passwordChars} />
          ) : (
            <PortalView />
          )}
        </div>
      </div>
      {agentCursor ? (
        <div className="zbd-rd-agent-cursor">
          <AgentCursorArrow />
        </div>
      ) : null}
      {showDock ? <Dock /> : null}
    </div>
  )
}

function AgentCursorArrow() {
  return (
    <svg aria-hidden="true" height="13" viewBox="0 0 16 16" width="13">
      <path
        d="M2 1.8 13.2 8.2l-5.1.9-2.7 4.4L2 1.8Z"
        fill="#F19D38"
        stroke="#fff"
        strokeLinejoin="round"
        strokeWidth="1.1"
      />
    </svg>
  )
}
