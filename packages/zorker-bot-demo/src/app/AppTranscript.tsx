import { useMemo, useSyncExternalStore, type ReactNode, type Ref, type UIEventHandler } from 'react'
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
import { MessageBubble, type MessageBubbleProps } from '../components/MessageBubble'
import { PendingRow } from '../components/PendingRow'
import { SystemEntry } from '../components/SystemEntry'
import {
  formatTranscriptTime,
  sessionToAgent,
  type AppSession,
} from './data'

const TIMESTAMP_GAP_MS = 15 * 60_000

const subscribeToTimeZone = () => () => {}
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const serverTimeZone = () => 'UTC'

function startsTimeGroup(previous: number | undefined, current: number, day: Intl.DateTimeFormat) {
  return previous === undefined || current - previous >= TIMESTAMP_GAP_MS ||
    day.format(previous) !== day.format(current)
}

function sameAuthor(left: TranscriptEntry | undefined, right: TranscriptEntry | undefined) {
  if (left?.kind === 'user-message' && right?.kind === 'user-message') return true
  if (left?.kind !== 'agent-message' || right?.kind !== 'agent-message') return false
  return (left.author?.id ?? '') === (right.author?.id ?? '')
}

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
  locale?: string
  replyTargetId?: string
  renderMessage?: (content: string) => ReactNode
  renderMessageMenu?: MessageBubbleProps['renderMenu']
  transcriptRef: Ref<HTMLDivElement>
  onScroll?: UIEventHandler<HTMLDivElement>
  onOpenComputer: () => void
  onTakeOver: () => void
  onFinishComputer: () => void
  onSuggestion: (suggestion: string) => void
  onReact?: (entry: Extract<TranscriptEntry, { kind: 'agent-message' | 'user-message' }>, emoji: string) => void
  getReplyAction?: (entry: Extract<TranscriptEntry, { kind: 'agent-message' | 'user-message' }>) => (() => void) | undefined
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
  locale,
  replyTargetId,
  renderMessage,
  renderMessageMenu,
  transcriptRef,
  onScroll,
  onOpenComputer,
  onTakeOver,
  onFinishComputer,
  onSuggestion,
  onReact,
  getReplyAction,
}: AppTranscriptProps) {
  const agent = sessionToAgent(session, displayName)
  const timeZone = useSyncExternalStore(subscribeToTimeZone, browserTimeZone, serverTimeZone)
  const day = useMemo(() => new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }), [timeZone])
  const dateTime = useMemo(() => locale && new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }), [locale, timeZone])
  let previousTimestamp: number | undefined

  return (
    <div className="zbd-transcript zbd-app-transcript" onScroll={onScroll} ref={transcriptRef}>
      <div className="zbd-transcript-inner zbd-app-transcript-inner">
        {entries.map((entry, index) => {
          const timestamp = entry.timestampMs
          const showTimestamp = timestamp !== undefined && startsTimeGroup(previousTimestamp, timestamp, day)
          if (timestamp !== undefined) previousTimestamp = timestamp
          const time = showTimestamp ? (
            <time className="zbd-time-separator" dateTime={new Date(timestamp).toISOString()} suppressHydrationWarning>
              {dateTime ? dateTime.format(timestamp) : formatTranscriptTime(timestamp)}
            </time>
          ) : null

          if (entry.kind === 'system') {
            return (
              <div className="zbd-entry" data-has-timestamp={showTimestamp ? '' : undefined} key={entry.id}>
                {time}
                <SystemEntry assetBase={assetBase} entry={entry} />
              </div>
            )
          }

          if (entry.kind === 'computer') {
            return (
              <div className="zbd-entry" data-has-timestamp={showTimestamp ? '' : undefined} key={entry.id}>
                {time}
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
              <div className="zbd-entry" data-has-timestamp={showTimestamp ? '' : undefined} key={entry.id}>
                {time}
                <ActivityCard entry={entry} />
              </div>
            )
          }

          if (entry.kind === 'confirmation') {
            return (
              <div className="zbd-entry" data-has-timestamp={showTimestamp ? '' : undefined} key={entry.id}>
                {time}
                <ConfirmationCard entry={entry} />
              </div>
            )
          }

          const authorLabel =
            entry.kind === 'agent-message' && session.isGroup
              ? entry.author?.name
              : undefined

          const previous = entries[index - 1]
          const next = entries[index + 1]
          const joinsPrevious = !showTimestamp && sameAuthor(previous, entry)
          const joinsNext = next?.timestampMs !== undefined &&
            !startsTimeGroup(entry.timestampMs, next.timestampMs, day) && sameAuthor(entry, next)
          const groupPosition = joinsPrevious
            ? joinsNext ? 'middle' : 'end'
            : joinsNext ? 'start' : 'single'

          return (
            <div
              className={
                authorLabel
                  ? 'zbd-entry zbd-app-group-entry'
                  : 'zbd-entry'
              }
              data-entry-id={entry.id}
              data-reply-target={entry.id === replyTargetId ? '' : undefined}
              data-has-timestamp={showTimestamp ? '' : undefined}
              data-same-group={joinsPrevious ? '' : undefined}
              key={entry.id}
            >
              {time}
              {authorLabel ? (
                <div className="zbd-app-group-author">{authorLabel}</div>
              ) : null}
              <MessageBubble
                assetBase={assetBase}
                entry={entry}
                groupPosition={groupPosition}
                onReact={onReact}
                onReply={getReplyAction?.(entry)}
                renderContent={renderMessage}
                renderMenu={renderMessageMenu}
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
