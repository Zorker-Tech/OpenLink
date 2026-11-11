import { AGENT_BY_NAME } from '../data/agents'
import { AgentAvatar } from './AgentAvatar'

export function SystemAgentPill({
  name,
  assetBase,
}: {
  name: string
  assetBase: string
}) {
  const agent = AGENT_BY_NAME[name]
  if (!agent) return <span className="zbd-system-agent">{name}</span>

  return (
    <span className="zbd-system-agent">
      <AgentAvatar agent={agent} assetBase={assetBase} size={12} />
      <span>{name}</span>
    </span>
  )
}
