import { useEffect, useState } from 'react'
import { RemoteDesktop } from '../remote-desktop/RemoteDesktop'
import type { ScriptedScreen } from '../types'
import { ClockIcon, CloseIcon, GearIcon } from '../components/icons'
import { DesktopPreview } from './DesktopPreview'
import type { AppRoutine, AppSession } from './data'

export type AppComputerPaneProps = {
  session: AppSession
  displayName: string
  assetBase: string
  isSales: boolean
  screen: ScriptedScreen
  onClose: () => void
  onOpenScreen: () => void
}

export function AppComputerPane({
  session,
  displayName,
  assetBase,
  isSales,
  screen,
  onClose,
  onOpenScreen,
}: AppComputerPaneProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [autoReview, setAutoReview] = useState(true)

  useEffect(() => {
    if (!settingsOpen) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [settingsOpen])

  return (
    <aside className="zbd-side-pane zbd-app-computer-pane">
      <div className="zbd-side-pane-inner">
        <header className="zbd-side-pane-header">
          <button
            aria-label="Agent settings"
            aria-expanded={settingsOpen}
            className="zbd-window-action"
            onClick={() => setSettingsOpen((open) => !open)}
            type="button"
          >
            <GearIcon size={15} />
          </button>
          <button
            aria-label="Close computer"
            className="zbd-window-action"
            onClick={onClose}
            type="button"
          >
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="zbd-side-pane-scroll">
          <button
            aria-label={`Open ${displayName}'s screen`}
            className="zbd-side-preview zbd-app-side-preview"
            data-zbd-thumb={isSales ? 'computer' : undefined}
            onClick={onOpenScreen}
            type="button"
          >
            {isSales ? (
              <RemoteDesktop
                assetBase={assetBase}
                emailChars={screen.emailChars}
                focus={screen.focus}
                passwordChars={screen.passwordChars}
                showDock={false}
                view={screen.view}
              />
            ) : (
              <DesktopPreview assetBase={assetBase} />
            )}
          </button>
          <div className="zbd-side-screen-label">{displayName}’s screen</div>
          <div className="zbd-side-section-title">Routines</div>
          {session.routines.length > 0 ? (
            session.routines.map((routine) => (
              <RoutineRow key={routine.id} routine={routine} />
            ))
          ) : (
            <div className="zbd-app-routine-empty">
              Nothing scheduled yet. Ask {displayName} to do something every
              morning and it shows up here.
            </div>
          )}
        </div>
        {settingsOpen ? (
          <div className="zbd-app-settings" role="dialog">
            <div className="zbd-app-settings-head">
              <span>
                <strong>{displayName}</strong>
                <small>{session.title}</small>
              </span>
              <button
                aria-label="Close settings"
                className="zbd-window-action"
                onClick={() => setSettingsOpen(false)}
                type="button"
              >
                <CloseIcon size={13} />
              </button>
            </div>
            <p className="zbd-app-settings-description">
              {session.description}
            </p>
            <div className="zbd-app-settings-group">
              <SettingToggle
                checked={notifications}
                label="Notifications"
                description="When this agent finishes or needs input"
                onChange={() => setNotifications((value) => !value)}
              />
              <SettingToggle
                checked={autoReview}
                label="Auto review"
                description="Check sensitive actions before they run"
                onChange={() => setAutoReview((value) => !value)}
              />
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}

function RoutineRow({ routine }: { routine: AppRoutine }) {
  return (
    <div className="zbd-routine-row zbd-app-routine-row">
      <span className="zbd-routine-icon">
        <ClockIcon size={15} />
      </span>
      <span className="zbd-routine-copy">
        <span>{routine.name}</span>
        <span>{routine.triggerDescription}</span>
      </span>
    </div>
  )
}

function SettingToggle({
  checked,
  label,
  description,
  onChange,
}: {
  checked: boolean
  label: string
  description: string
  onChange: () => void
}) {
  return (
    <button
      aria-checked={checked}
      className="zbd-app-setting-toggle"
      onClick={onChange}
      role="switch"
      type="button"
    >
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="zbd-app-switch" data-on={checked ? '' : undefined}>
        <span />
      </span>
    </button>
  )
}
