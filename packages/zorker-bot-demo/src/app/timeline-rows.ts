import type { TranscriptEntry } from '../types'

const TIMESTAMP_GAP_MS = 15 * 60_000

export type TimelineRow = {
  kind: 'entry' | 'attachments' | 'tools' | 'routines'
  entries: TranscriptEntry[]
  index: number
  timestamp?: number
  dayStart?: 'initial' | 'boundary'
  unread: boolean
}

function calendarDay(formatter: Intl.DateTimeFormat, timestamp: number) {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(({ type, value }) => [type, Number(value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!) / 86_400_000
}

export function createTimelineTimeFormatter(locale: string, day: Intl.DateTimeFormat, now: number) {
  const { timeZone } = day.resolvedOptions()
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone })
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short', timeZone })
  const archivedDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone })
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const today = calendarDay(day, now)
  const year = day.formatToParts(now).find(({ type }) => type === 'year')?.value

  return (timestamp: number, dayStart: TimelineRow['dayStart']) => {
    const time = clock.format(timestamp)
    if (!dayStart) return time
    const offset = calendarDay(day, timestamp) - today
    if (offset === 0 && dayStart === 'initial') return time
    if (offset === 0 || offset === -1) return `${relative.format(offset, 'day')} · ${time}`
    const sameYear = day.formatToParts(timestamp).find(({ type }) => type === 'year')?.value === year
    return `${(sameYear ? date : archivedDate).format(timestamp)} · ${time}`
  }
}

function groupFor(entry: TranscriptEntry) {
  if (entry.kind === 'activity' && entry.activity.tool === 'tool') return { kind: 'tools', key: 'tools' } as const
  if (entry.kind === 'system' && (entry.event.type === 'created-routine' || entry.event.type === 'routine-changed')) {
    return { kind: 'routines', key: 'routines' } as const
  }
  if ((entry.kind === 'agent-message' || entry.kind === 'user-message') && entry.attachment?.batchId) {
    const author = entry.kind === 'agent-message' ? entry.author?.id : undefined
    return { kind: 'attachments', key: JSON.stringify([entry.kind, author, entry.attachment.batchId]) } as const
  }
  return { kind: 'entry', key: null } as const
}

export function startsTimeGroup(previous: number | undefined, current: number, day: Intl.DateTimeFormat) {
  return previous === undefined || current - previous >= TIMESTAMP_GAP_MS ||
    day.format(previous) !== day.format(current)
}

/** Fold adjacent entries in transport order without hiding their identities. */
export function foldTimeline(entries: readonly TranscriptEntry[], day: Intl.DateTimeFormat, unreadAfter?: number): TimelineRow[] {
  const rows: TimelineRow[] = []
  let previousTimestamp: number | undefined
  let previousKey: string | null = null
  let markedUnread = false
  entries.forEach((entry, index) => {
    const at = entry.timestampMs
    const timestamp = at !== undefined && startsTimeGroup(previousTimestamp, at, day) ? at : undefined
    const dayStart = timestamp === undefined ? undefined : previousTimestamp === undefined ? 'initial'
      : day.format(previousTimestamp) !== day.format(timestamp) ? 'boundary' : undefined
    const unread = !markedUnread && unreadAfter !== undefined && at !== undefined && at > unreadAfter
    if (at !== undefined) previousTimestamp = at
    if (unread) markedUnread = true
    const group = groupFor(entry)
    const previous = rows.at(-1)
    if (previous && group.key !== null && group.key === previousKey && timestamp === undefined && !unread) {
      previous.entries.push(entry)
    } else {
      rows.push({ kind: group.kind, entries: [entry], index, timestamp, dayStart, unread })
    }
    previousKey = group.key
  })
  return rows
}
