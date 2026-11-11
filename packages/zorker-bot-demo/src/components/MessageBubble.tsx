import type { CSSProperties } from 'react'
import { reactionMask } from '../lib/reaction-mask'
import { formatTime } from '../lib/format-time'
import type { TranscriptEntry } from '../types'
import { RichText } from './RichText'

export type MessageBubbleProps = {
  entry: Extract<TranscriptEntry, { kind: 'agent-message' | 'user-message' }>
  assetBase: string
  showTimestamp?: boolean
  timestampLabel?: string
}

export function MessageBubble({
  entry,
  assetBase,
  showTimestamp = false,
  timestampLabel,
}: MessageBubbleProps) {
  const isUser = entry.kind === 'user-message'
  const reactions = entry.reactions ?? []
  const mask = reactions.length > 0
    ? (reactionMask(reactions.length, isUser ? 'user' : 'agent') as CSSProperties)
    : undefined

  return (
    <>
      {showTimestamp ? (
        <div className="zbd-time-separator" suppressHydrationWarning>
          {timestampLabel ?? formatTime(entry.timestampMs)}
        </div>
      ) : null}
      <div className={isUser ? 'zbd-message-row zbd-message-row-user' : 'zbd-message-row'}>
        <div className={isUser ? 'zbd-bubble-wrap zbd-bubble-wrap-user' : 'zbd-bubble-wrap'}>
          <div
            className={isUser ? 'zbd-bubble zbd-bubble-user' : 'zbd-bubble zbd-bubble-agent'}
            style={mask}
          >
            {isUser ? entry.content : <RichText assetBase={assetBase} content={entry.content} />}
          </div>
          {reactions.length > 0 ? (
            <span className={isUser ? 'zbd-reactions zbd-reactions-user' : 'zbd-reactions zbd-reactions-agent'}>
              {reactions.map((reaction) => (
                <span className="zbd-reaction" key={reaction}>{reaction}</span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </>
  )
}
