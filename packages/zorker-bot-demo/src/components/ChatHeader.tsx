import type { Agent } from '../types'
import { AgentAvatar } from './AgentAvatar'
import { MonitorIcon } from './icons'

export type ChatHeaderProps = {
  agent: Agent
  assetBase: string
  computerOpen: boolean
  onToggleComputer: () => void
}

export function ChatHeader({
  agent,
  assetBase,
  computerOpen,
  onToggleComputer,
}: ChatHeaderProps) {
  return (
    <header className="zbd-chat-header">
      <div className="zbd-chat-header-left">
        <button
          aria-label={`Open ${agent.name}'s computer`}
          className="zbd-agent-title"
          onClick={onToggleComputer}
          type="button"
        >
          <AgentAvatar agent={agent} assetBase={assetBase} size={18} />
          <span className="zbd-agent-title-text">{agent.name}</span>
        </button>
      </div>
      <div className="zbd-chat-header-actions">
        <button
          aria-label={computerOpen ? 'Hide computer' : 'Open computer'}
          aria-pressed={computerOpen}
          className="zbd-icon-button"
          onClick={onToggleComputer}
          type="button"
        >
          <MonitorIcon size={16} />
        </button>
      </div>
    </header>
  )
}
