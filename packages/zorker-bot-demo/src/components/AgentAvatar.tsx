import { AGENTS } from '../data/agents'
import type { Agent } from '../types'

export type AgentAvatarProps = {
  agent: Agent
  assetBase: string
  size?: number
  className?: string
}

export function AgentAvatar({
  agent,
  assetBase,
  size = 32,
  className,
}: AgentAvatarProps) {
  if (agent.group) {
    const members = agent.group
      .map((id) => AGENTS.find((item) => item.id === id))
      .filter((item): item is Agent => Boolean(item))

    return (
      <span
        aria-hidden="true"
        className={`zbd-agent-avatar zbd-agent-avatar-group ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        {members.map((member, index) => (
          <span
            className="zbd-agent-avatar-group-item"
            key={member.id}
            style={{
              width: size * 0.56,
              height: size * 0.56,
              left: index === 0 ? 0 : index === 1 ? size * 0.44 : size * 0.22,
              top: index === 0 ? 0 : index === 1 ? 0 : size * 0.44,
              zIndex: index === 2 ? 3 : index === 1 ? 2 : 1,
              background: member.ink,
            }}
          >
            <img alt="" draggable={false} src={`${assetBase}/avatars/${member.avatar}.svg`} />
          </span>
        ))}
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={`zbd-agent-avatar ${className ?? ''}`}
      style={{ width: size, height: size, ['--agent-ink' as string]: agent.ink }}
    >
      <img alt="" draggable={false} src={`${assetBase}/avatars/${agent.avatar}.svg`} />
    </span>
  )
}
