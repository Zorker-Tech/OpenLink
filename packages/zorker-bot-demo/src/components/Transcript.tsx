import type { Ref } from 'react'
import type {
  ComputerStatus,
  PendingBeat,
  ScriptedScreen,
  TranscriptEntry,
} from '../types'
import { ActivityCard } from './ActivityCard'
import { ComputerCard } from './ComputerCard'
import { ConfirmationCard } from './ConfirmationCard'
import { MessageBubble } from './MessageBubble'
import { PendingRow } from './PendingRow'
import { SystemEntry } from './SystemEntry'

export type TranscriptProps = {
  entries: TranscriptEntry[]
  pending: PendingBeat | null
  screen: ScriptedScreen
  cardStatus: ComputerStatus
  assetBase: string
  transcriptRef: Ref<HTMLDivElement>
  onOpenComputer: () => void
  onTakeOver: () => void
  onFinishComputer: () => void
  onReact?: (entry: Extract<TranscriptEntry, { kind: 'agent-message' | 'user-message' }>, emoji: string) => void
}

export function Transcript({
  entries,
  pending,
  screen,
  cardStatus,
  assetBase,
  transcriptRef,
  onOpenComputer,
  onTakeOver,
  onFinishComputer,
  onReact,
}: TranscriptProps) {
  const firstMessageId = entries.find(
    (entry) => entry.kind === 'agent-message' || entry.kind === 'user-message',
  )?.id

  return (
    <div className="zbd-transcript" ref={transcriptRef}>
      <div className="zbd-transcript-inner">
        {entries.map((entry, index) => {
          if (entry.kind === 'system') {
            return (
              <div className="zbd-entry" key={entry.id}>
                <SystemEntry assetBase={assetBase} entry={entry} />
              </div>
            )
          }

          if (entry.kind === 'computer') {
            return (
              <div className="zbd-entry" key={entry.id}>
                <ComputerCard
                  assetBase={assetBase}
                  entry={entry}
                  onFinish={onFinishComputer}
                  onOpen={onOpenComputer}
                  onTakeOver={onTakeOver}
                  screen={screen}
                  status={cardStatus}
                />
              </div>
            )
          }

          if (entry.kind === 'activity') {
            return (
              <div className="zbd-entry" key={entry.id}>
                <ActivityCard entry={entry} />
              </div>
            )
          }

          if (entry.kind === 'confirmation') {
            return (
              <div className="zbd-entry" key={entry.id}>
                <ConfirmationCard entry={entry} />
              </div>
            )
          }

          const previous = entries[index - 1]
          const next = entries[index + 1]
          const sameAuthor = (left: TranscriptEntry | undefined, right: TranscriptEntry | undefined) => {
            if (left?.kind === 'user-message' && right?.kind === 'user-message') return true
            if (left?.kind !== 'agent-message' || right?.kind !== 'agent-message') return false
            return (left.author?.id ?? '') === (right.author?.id ?? '')
          }
          const joinsPrevious = sameAuthor(previous, entry)
          const joinsNext = sameAuthor(entry, next)
          const groupPosition = joinsPrevious
            ? joinsNext ? 'middle' : 'end'
            : joinsNext ? 'start' : 'single'

          return (
            <div className="zbd-entry" data-same-group={joinsPrevious ? '' : undefined} key={entry.id}>
              <MessageBubble
                assetBase={assetBase}
                entry={entry}
                groupPosition={groupPosition}
                onReact={onReact}
                showTimestamp={entry.id === firstMessageId}
              />
            </div>
          )
        })}
        {pending ? (
          <div className="zbd-entry">
            <PendingRow assetBase={assetBase} pending={pending} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
