import { AgentAvatar } from '../components/AgentAvatar'
import { BackArrowIcon, GearIcon, MonitorIcon } from '../components/icons'
import { sessionToAgent, type AppSession } from './data'

export type AppChatHeaderProps = {
  session: AppSession
  displayName: string
  assetBase: string
  computerOpen: boolean
  showBack: boolean
  introRunning: boolean
  onBack: () => void
  onToggleComputer: () => void
  onSkipIntro: () => void
  onOpenProfile?: () => void
}

export function AppChatHeader({
  session,
  displayName,
  assetBase,
  computerOpen,
  showBack,
  introRunning,
  onBack,
  onToggleComputer,
  onSkipIntro,
  onOpenProfile,
}: AppChatHeaderProps) {
  const agent = sessionToAgent(session, displayName)

  return (
    <header className="zbd-chat-header zbd-app-chat-header">
      <div className="zbd-chat-header-left">
        {showBack ? (
          <button
            aria-label="Back"
            className="zbd-icon-button zbd-app-back"
            onClick={onBack}
            type="button"
          >
            <BackArrowIcon size={15} />
          </button>
        ) : null}
        <button
          aria-label={`Open ${displayName}'s computer`}
          className="zbd-agent-title"
          onClick={onToggleComputer}
          type="button"
        >
          <AgentAvatar
            agent={agent}
            assetBase={assetBase}
            className={session.isDraft ? 'zbd-app-avatar-new' : undefined}
            size={18}
          />
          <span className="zbd-agent-title-text">{displayName}</span>
        </button>
      </div>
      <div className="zbd-chat-header-actions">
        {introRunning ? (
          <button
            className="zbd-app-skip"
            onClick={onSkipIntro}
            type="button"
          >
            Skip intro
          </button>
        ) : null}
        {onOpenProfile ? (
          <button
            aria-label="Open profile"
            className="zbd-icon-button"
            onClick={onOpenProfile}
            title="Profile"
            type="button"
          >
            <GearIcon size={16} />
          </button>
        ) : null}
        <button
          aria-label={computerOpen ? 'Hide computer' : 'Open computer'}
          aria-pressed={computerOpen}
          className="zbd-icon-button"
          onClick={onToggleComputer}
          title={computerOpen ? 'Hide computer' : 'Open computer'}
          type="button"
        >
          <MonitorIcon size={16} />
        </button>
      </div>
    </header>
  )
}
