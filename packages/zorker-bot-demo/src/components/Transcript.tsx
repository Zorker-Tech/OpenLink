import type { Ref } from 'react'
import type {
  ComputerStatus,
  PendingBeat,
  ScriptedScreen,
  TranscriptEntry,
} from '../types'
import { ComputerCard } from './ComputerCard'
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
}: TranscriptProps) {
  const firstMessageId = entries.find(
    (entry) => entry.kind === 'agent-message' || entry.kind === 'user-message',
  )?.id

  return (
    <div className="zbd-transcript" ref={transcriptRef}>
      <div className="zbd-transcript-inner">
        {entries.map((entry) => {
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

          return (
            <div className="zbd-entry" key={entry.id}>
              <MessageBubble
                assetBase={assetBase}
                entry={entry}
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
