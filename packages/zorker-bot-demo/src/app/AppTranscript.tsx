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
import { createTimelineTimeFormatter, foldTimeline, startsTimeGroup } from './timeline-rows'
import {
  formatTranscriptTime,
  sessionToAgent,
  type AppSession,
} from './data'

const subscribeToTimeZone = () => () => {}
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const serverTimeZone = () => 'UTC'

function sameAuthor(left: TranscriptEntry | undefined, right: TranscriptEntry | undefined) {
  if (left?.kind === 'user-message' && right?.kind === 'user-message') return !left.attachment && !right.attachment
  if (left?.kind !== 'agent-message' || right?.kind !== 'agent-message') return false
  return !left.attachment && !right.attachment && (left.author?.id ?? '') === (right.author?.id ?? '')
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
  unreadAfter?: number
  renderMessage?: (content: string) => ReactNode
  renderMessageActions?: MessageBubbleProps['renderActions']
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
  unreadAfter,
  renderMessage,
  renderMessageActions,
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
  const day = useMemo(() => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }), [timeZone])
  const dateTime = locale && createTimelineTimeFormatter(locale, day, Date.now())
  const rows = useMemo(() => foldTimeline(entries, day, unreadAfter), [entries, day, unreadAfter])

  const renderEntry = (entry: TranscriptEntry, groupPosition: MessageBubbleProps['groupPosition'], showAuthor: boolean) => {
    switch (entry.kind) {
      case 'system':
        return <SystemEntry assetBase={assetBase} entry={entry} />
      case 'computer':
        return <ComputerCard assetBase={assetBase} entry={entry} onFinish={onFinishComputer} onOpen={onOpenComputer} onTakeOver={onTakeOver} screen={screen} status={cardStatus} />
      case 'activity':
        return <ActivityCard entry={entry} />
      case 'confirmation':
        return <ConfirmationCard entry={entry} />
      case 'agent-message':
      case 'user-message':
        return (
          <>
            {showAuthor && session.isGroup && entry.kind === 'agent-message' && entry.author?.name ? (
              <div className="zbd-app-group-author">{entry.author.name}</div>
            ) : null}
            <MessageBubble
              assetBase={assetBase}
              entry={entry}
              groupPosition={groupPosition}
              onReact={onReact}
              onReply={getReplyAction?.(entry)}
              renderActions={renderMessageActions}
              renderContent={renderMessage}
              renderMenu={renderMessageMenu}
            />
          </>
        )
    }
  }

  return (
    <div className="zbd-transcript zbd-app-transcript" onScroll={onScroll} ref={transcriptRef}>
      <div className="zbd-transcript-inner zbd-app-transcript-inner">
        {rows.map(({ dayStart, entries: grouped, index, kind, timestamp, unread }) => {
          const entry = grouped[0]!
          const time = timestamp !== undefined ? (
            <time className="zbd-time-separator" dateTime={new Date(timestamp).toISOString()} suppressHydrationWarning>
              {dateTime ? dateTime(timestamp, dayStart) : formatTranscriptTime(timestamp)}
            </time>
          ) : null

          const previous = entries[index - 1]
          const next = entries[index + 1]
          const joinsPrevious = timestamp === undefined && !unread && sameAuthor(previous, entry)
          const joinsNext = entry.timestampMs !== undefined && next?.timestampMs !== undefined &&
            !(unreadAfter !== undefined && entry.timestampMs <= unreadAfter && next.timestampMs > unreadAfter) &&
            !startsTimeGroup(entry.timestampMs, next.timestampMs, day) && sameAuthor(entry, next)
          const groupPosition = joinsPrevious
            ? joinsNext ? 'middle' : 'end'
            : joinsNext ? 'start' : 'single'

          const divider = unread ? <div className="zbd-timeline-unread" role="separator" aria-label="Unread messages">Unread messages</div> : null
          const renderGroupedEntries = () => grouped.map((member, offset) => (
            <div data-entry-id={member.id} data-reply-target={member.id === replyTargetId ? '' : undefined} key={member.id}>
              {renderEntry(member, 'single', offset === 0)}
            </div>
          ))
          const visible = kind === 'tools' ? (
            <details className="zbd-tool-run">
              <summary>{grouped.length === 1 ? 'Tool activity' : `${grouped.length} tool steps`}</summary>
              <div className="zbd-timeline-group">{renderGroupedEntries()}</div>
            </details>
          ) : grouped.length > 1 ? (
            <div className="zbd-timeline-group" role="group" aria-label={kind === 'attachments' ? 'Attachments' : 'Routine updates'}>
              {renderGroupedEntries()}
            </div>
          ) : renderEntry(entry, groupPosition, !joinsPrevious)

          return (
            <div
              className={session.isGroup && entry.kind === 'agent-message' && entry.author?.name ? 'zbd-entry zbd-app-group-entry' : 'zbd-entry'}
              data-entry-id={grouped.length === 1 && kind !== 'tools' ? entry.id : undefined}
              data-reply-target={grouped.length === 1 && entry.id === replyTargetId ? '' : undefined}
              data-has-timestamp={timestamp !== undefined ? '' : undefined}
              data-same-group={joinsPrevious ? '' : undefined}
              key={entry.id}
            >
              {time}
              {divider}
              {visible}
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
