import { AGENT_BY_NAME } from '../data/agents'
import { RICH_TEXT_PATTERN } from '../lib/rich-text'
import { AgentAvatar } from './AgentAvatar'

export type RichTextProps = {
  content: string
  assetBase: string
  className?: string
}

export function RichText({ content, assetBase, className }: RichTextProps) {
  const parts = content.split(RICH_TEXT_PATTERN)

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={index}>{part.slice(2, -2)}</strong>
        }
        if (part.startsWith('@[') && part.endsWith(']')) {
          const name = part.slice(2, -1)
          const agent = AGENT_BY_NAME[name]
          return (
            <span
              className="zbd-mention"
              key={index}
              style={{ color: agent?.ink ?? 'var(--zbd-current-accent)' }}
            >
              {agent ? <AgentAvatar agent={agent} assetBase={assetBase} size={14} /> : null}
              {name}
            </span>
          )
        }
        return <span key={index}>{part}</span>
      })}
    </span>
  )
}
