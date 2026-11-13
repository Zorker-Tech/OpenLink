import type { ReactNode, Ref } from 'react'
import type {
  ComputerStatus,
  PendingBeat,
  ScriptedScreen,
  TranscriptEntry,
} from '../types'
import { ActivityCard } from '../components/ActivityCard'
import { AgentAvatar } from '../components/AgentAvatar'
import { ComputerCard } from '../components/ComputerCard'
import { ConfirmationCard } from '../components/ConfirmationCard'
import { MessageBubble } from '../components/MessageBubble'
import { PendingRow } from '../components/PendingRow'
import { SystemEntry } from '../components/SystemEntry'
import {
  formatTranscriptTime,
  sessionToAgent,
  type AppSession,
} from './data'

const TIMESTAMP_GAP_MS = 60_000

const EMPTY_SUGGESTIONS = [
  'Research my pipeline and draft outreach',
  'Triage my inbox and flag what needs me',
  'Prep me for tomorrow’s meetings',
]

export type AppTranscriptProps = {
  entries: TranscriptEntry[]
  pending: PendingBeat | null
  status?: ReactNode
  screen: ScriptedScreen
  cardStatus: ComputerStatus
  assetBase: string
  session: AppSession
  displayName: string
  renderMessage?: (content: string) => ReactNode
  transcriptRef: Ref<HTMLDivElement>
  onOpenComputer: () => void
  onTakeOver: () => void
  onFinishComputer: () => void
  onSuggestion: (suggestion: string) => void
}

export function AppTranscript({
  entries,
  pending,
  status,
  screen,
  cardStatus,
  assetBase,
  session,
  displayName,
  renderMessage,
  transcriptRef,
  onOpenComputer,
  onTakeOver,
  onFinishComputer,
  onSuggestion,
}: AppTranscriptProps) {
  const agent = sessionToAgent(session, displayName)
  let previousTimestamp: number | null = null

  return (
    <div className="zbd-transcript zbd-app-transcript" ref={transcriptRef}>
      <div className="zbd-transcript-inner zbd-app-transcript-inner">
        {entries.map((entry) => {
          if (entry.kind === 'system') {
            const showTimestamp =
              previousTimestamp === null ||
              entry.timestampMs - previousTimestamp >= TIMESTAMP_GAP_MS
            previousTimestamp = entry.timestampMs
            return (
              <div className="zbd-entry" key={entry.id}>
                {showTimestamp ? (
                  <div className="zbd-time-separator" suppressHydrationWarning>
                    {formatTranscriptTime(entry.timestampMs)}
                  </div>
                ) : null}
                <SystemEntry assetBase={assetBase} entry={entry} />
              </div>
            )
          }

          if (entry.kind === 'computer') {
            if (entry.timestampMs !== undefined) {
              previousTimestamp = entry.timestampMs
            }
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
            previousTimestamp = entry.timestampMs
            return (
              <div className="zbd-entry" key={entry.id}>
                <ActivityCard entry={entry} />
              </div>
            )
          }

          if (entry.kind === 'confirmation') {
            previousTimestamp = entry.timestampMs
            return (
              <div className="zbd-entry" key={entry.id}>
                <ConfirmationCard entry={entry} />
              </div>
            )
          }

          const showTimestamp =
            previousTimestamp === null ||
            entry.timestampMs - previousTimestamp >= TIMESTAMP_GAP_MS
          previousTimestamp = entry.timestampMs

          const authorLabel =
            entry.kind === 'agent-message' && session.isGroup
              ? entry.author?.name
              : undefined

          return (
            <div
              className={
                authorLabel
                  ? 'zbd-entry zbd-app-group-entry'
                  : 'zbd-entry'
              }
              key={entry.id}
            >
              {authorLabel ? (
                <div className="zbd-app-group-author">{authorLabel}</div>
              ) : null}
              <MessageBubble
                assetBase={assetBase}
                entry={entry}
                renderContent={renderMessage}
                showTimestamp={showTimestamp}
                timestampLabel={
                  showTimestamp
                    ? formatTranscriptTime(entry.timestampMs)
                    : undefined
                }
              />
            </div>
          )
        })}
        {pending ? (
          <div className="zbd-entry">
            <PendingRow assetBase={assetBase} pending={pending} />
          </div>
        ) : null}
        {status ? (
          <div className="zbd-entry zbd-app-task-status">{status}</div>
        ) : null}
        {entries.length === 0 && !pending && !status ? (
          <div className="zbd-app-empty">
            <span className="zbd-app-empty-avatar">
              <AgentAvatar
                agent={agent}
                assetBase={assetBase}
                className={session.isDraft ? 'zbd-app-avatar-new' : undefined}
                size={52}
              />
            </span>
            <h2>What should this agent take off your plate?</h2>
            <p>
              Give it a real outcome. It can work across your tools and come
              back with something finished.
            </p>
            <div className="zbd-app-empty-suggestions">
              {EMPTY_SUGGESTIONS.map((suggestion) => (
                <button
                  className="zbd-app-empty-suggestion"
                  key={suggestion}
                  onClick={() => onSuggestion(suggestion)}
                  type="button"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
