import type { Agent, AgentId, TranscriptEntry } from '../types'

export type AppRoutine = {
  id: string
  name: string
  triggerDescription: string
}

export type AppSession = {
  id: string
  name: string
  title: string
  description: string
  avatar: string
  avatarColor?: string
  avatarUrl?: string
  ink: string
  group?: AgentId[]
  isGroup?: boolean
  unread?: boolean
  unreadCount?: number
  lastActivityMs: number
  lastEntryText: string
  transcript: TranscriptEntry[]
  routines: AppRoutine[]
  screenKind: 'crm-portal' | 'desktop'
  isDraft?: boolean
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export const APP_NOW = Date.now()

export const SALES_ROUTINE: AppRoutine = {
  id: 'outbound-auto-1',
  name: 'Overnight outbound',
  triggerDescription: 'Sundays at 11:00 PM',
}

const CHIEF_ROUTINES: AppRoutine[] = [
  {
    id: 'chief-auto-1',
    name: 'Morning briefing',
    triggerDescription: 'Weekdays at 8:00 AM',
  },
  {
    id: 'chief-auto-2',
    name: 'End-of-week recap',
    triggerDescription: 'Fridays at 5:00 PM',
  },
]

const EXPENSE_ROUTINES: AppRoutine[] = [
  {
    id: 'expense-auto-1',
    name: 'Month-end close',
    triggerDescription: 'Last Friday of the month',
  },
]

const CHIEF_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'system',
    id: 'chief-1',
    timestampMs: APP_NOW - 9 * DAY,
    event: {
      type: 'created-routine',
      name: 'Morning briefing',
      triggerDescription: 'Weekdays at 8:00 AM',
    },
  },
  {
    kind: 'agent-message',
    id: 'chief-2',
    timestampMs: APP_NOW - 24 * HOUR,
    content:
      "morning briefing:\n✓ **Calendar** → 2pm double-booking resolved · board review kept\n✓ **Deck** → numbers checked against finance's sheet · 2 stale slides flagged\n✓ **Offsite** → 3 venues shortlisted · dates held on each\n\ntwo things need you today: the deck review at 2pm, and a yes/no on the venue. everything else is handled.",
  },
  {
    kind: 'user-message',
    id: 'chief-3',
    content: "take the venue, i'll do the deck",
    timestampMs: APP_NOW - 21 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'chief-4',
    timestampMs: APP_NOW - 21 * HOUR,
    content:
      "the marina house is the pick: seats all 40, the mid-week rate came in 15% under budget, and they'll hold the date until tomorrow.",
  },
  {
    kind: 'user-message',
    id: 'chief-5',
    content: 'book it',
    reactions: ['👍'],
    timestampMs: APP_NOW - 20 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'chief-6',
    timestampMs: APP_NOW - 20 * HOUR,
    content:
      '✓ **Venue** → marina house booked · deposit paid\n✓ **Calendar** → invites updated for all 40\n✓ **Holds** → other two released with a thank-you',
  },
  {
    kind: 'agent-message',
    id: 'chief-7',
    timestampMs: APP_NOW - 20 * HOUR,
    content:
      "booked the venue and sent the confirmation around. you're clear until the 2pm deck review.",
  },
]

const INBOX_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'user-message',
    id: 'inbox-1',
    content: 'inbox got away from me over the weekend, sweep it?',
    timestampMs: APP_NOW - 4 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'inbox-2',
    timestampMs: APP_NOW - 4 * HOUR,
    content:
      'on it. **41 unread** since friday. archiving the noise, drafting the rest.',
  },
  {
    kind: 'agent-message',
    id: 'inbox-3',
    timestampMs: APP_NOW - 3 * HOUR,
    content:
      '✓ **Archived** → 26 newsletters + receipts\n✓ **Replied** → 9 routine threads · scheduling and intros\n✓ **Drafted** → 6 that sound like you · held for your read\n✓ **Flagged** → 1 from dana · contract question',
  },
  {
    kind: 'agent-message',
    id: 'inbox-4',
    timestampMs: APP_NOW - 3 * HOUR,
    content:
      "dana's asking whether the renewal covers the new seats. her draft answers yes and quotes the contract line. it's at the top of the held pile.",
  },
  {
    kind: 'user-message',
    id: 'inbox-5',
    content: "send dana's, i'll take the rest tomorrow",
    reactions: ['👍'],
    timestampMs: APP_NOW - 3 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'inbox-6',
    timestampMs: APP_NOW - 3 * HOUR,
    content:
      'sent. inbox is at **zero**, with 5 drafts parked for tomorrow.',
  },
]

const ACCOUNT_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'user-message',
    id: 'account-1',
    content: "where are we with acme? renewal can't sneak up on us",
    timestampMs: APP_NOW - 6 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'account-2',
    timestampMs: APP_NOW - 6 * HOUR,
    content:
      'pulling usage, open threads, and the exec notes together now.',
  },
  {
    kind: 'agent-message',
    id: 'account-3',
    timestampMs: APP_NOW - 5 * HOUR,
    content:
      '**acme** renews in 60 days:\n✓ **Usage** → 214 seats active · up 18% this quarter\n✓ **Threads** → 2 open · security review + a pricing question\n✓ **Next step** → renewal call with vicky drafted · week of the 18th',
  },
  {
    kind: 'agent-message',
    id: 'account-4',
    timestampMs: APP_NOW - 5 * HOUR,
    content:
      'globex is the quiet one: nothing since the pilot wrapped. i wrote a re-engagement note that leads with their own pilot numbers. it’s in drafts, not sent.',
  },
  {
    kind: 'user-message',
    id: 'account-5',
    content:
      "send the acme invite. hold globex until i've read the note",
    reactions: ['👍'],
    timestampMs: APP_NOW - 5 * HOUR,
  },
  {
    kind: 'system',
    id: 'account-6',
    timestampMs: APP_NOW - 5 * HOUR,
    event: { type: 'memory-updated' },
  },
  {
    kind: 'agent-message',
    id: 'account-7',
    timestampMs: APP_NOW - 5 * HOUR,
    content:
      "invite's out to vicky. the globex note is holding in drafts, and quiet-account sends wait for your read from now on.",
  },
]

const TALENT_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'user-message',
    id: 'talent-1',
    content:
      'take the platform engineer req: senior, infra-heavy, remote ok. source quietly.',
    timestampMs: APP_NOW - 24 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'talent-2',
    timestampMs: APP_NOW - 24 * HOUR,
    content:
      "on it. i'll screen overnight against the req and skip anyone already in the ats.",
  },
  {
    kind: 'agent-message',
    id: 'talent-3',
    timestampMs: APP_NOW - 9 * HOUR,
    content:
      'overnight run:\n✓ **Sourced** → 64 profiles matched the req\n✓ **Skipped** → 11 already in the ats\n✓ **Shortlist** → 12 screened · notes on each',
  },
  {
    kind: 'agent-message',
    id: 'talent-4',
    timestampMs: APP_NOW - 9 * HOUR,
    content:
      'three worth your time first:\n**Mara Iyer** → scaled ingest 40× at a data startup · writes like an owner\n**Tomás Rivera** → runs a 6-person infra team · wants to build again\n**Grace Osei** → your exact stack end to end · shipped the migration you keep citing',
  },
  {
    kind: 'user-message',
    id: 'talent-5',
    content: 'strong list, mara especially. draft the intros',
    reactions: ['👍'],
    timestampMs: APP_NOW - 8 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'talent-6',
    timestampMs: APP_NOW - 8 * HOUR,
    content:
      "3 intros drafted in your voice and held for your ok. nothing sends until you've read them.",
  },
]

const EXPENSE_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'user-message',
    id: 'expense-1',
    content: 'month-end is friday, close out the card for me?',
    timestampMs: APP_NOW - 24 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'expense-2',
    timestampMs: APP_NOW - 24 * HOUR,
    content:
      "i'll match every charge to a receipt and file the report. anything that doesn't line up, i ask instead of guessing.",
  },
  {
    kind: 'system',
    id: 'expense-3',
    timestampMs: APP_NOW - 24 * HOUR,
    event: {
      type: 'created-routine',
      name: 'Month-end close',
      triggerDescription: 'Last Friday of the month',
    },
  },
  {
    kind: 'agent-message',
    id: 'expense-4',
    timestampMs: APP_NOW - 5 * HOUR,
    content:
      '✓ **Receipts** → 9 matched to card charges\n✓ **Report** → drafted · $2,340 across 3 trips\n✓ **Flagged** → 1 charge · harbor hotel, $412 twice',
  },
  {
    kind: 'agent-message',
    id: 'expense-5',
    timestampMs: APP_NOW - 5 * HOUR,
    content:
      'the harbor hotel charged $412 on the 12th and again on the 14th. double-billed, or two separate nights?',
  },
  {
    kind: 'user-message',
    id: 'expense-6',
    content: 'two nights, mia stayed the second one',
    timestampMs: APP_NOW - 4 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'expense-7',
    timestampMs: APP_NOW - 4 * HOUR,
    content:
      'that clears it. report filed: **9 receipts** matched, $2,340 across 3 trips, nothing outstanding.',
  },
]

const OFFSITE_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'user-message',
    id: 'crew-1',
    content: "let's close out the offsite. what's left?",
    timestampMs: APP_NOW - 7 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'crew-2',
    author: { id: 'account-manager', name: 'Account Manager' },
    timestampMs: APP_NOW - 7 * HOUR,
    content:
      'recap doc is done and owners are tagged. **3 follow-ups** land this week.',
  },
  {
    kind: 'agent-message',
    id: 'crew-3',
    author: { id: 'inbox-manager', name: 'Inbox Manager' },
    timestampMs: APP_NOW - 7 * HOUR,
    content:
      'thank-you notes went out to the venue and the speakers this morning.',
  },
  {
    kind: 'agent-message',
    id: 'crew-4',
    author: { id: 'chief-of-staff', name: 'Chief' },
    reactions: ['👍'],
    timestampMs: APP_NOW - 6 * HOUR,
    content:
      "recap's shared. follow-ups, assigned:\n✓ **Acme pricing follow-up** → @[Account Manager] · numbers by thursday\n✓ **Speaker + venue thank-yous** → @[Inbox Manager] · done this morning\n✓ **Final invoice** → me · reconciling against the expense report",
  },
  {
    kind: 'user-message',
    id: 'crew-5',
    content: 'great close-out. anything we missed?',
    timestampMs: APP_NOW - 6 * HOUR,
  },
  {
    kind: 'agent-message',
    id: 'crew-6',
    author: { id: 'chief-of-staff', name: 'Chief' },
    timestampMs: APP_NOW - 6 * HOUR,
    content:
      "that leaves the pipeline: nobody's touched the quiet accounts. i'd spin up a dedicated agent for outbound.",
  },
]

export const APP_SESSIONS: AppSession[] = [
  {
    id: 'chief-of-staff',
    name: 'Chief',
    title: 'Right hand',
    description:
      'Runs your day: triages asks, preps decisions, and keeps the rest of the team pointed at what matters.',
    avatar: 'chief',
    ink: '#54B9A6',
    lastActivityMs: APP_NOW - 20 * HOUR,
    lastEntryText:
      'booked the venue and sent the confirmation around.',
    transcript: CHIEF_TRANSCRIPT,
    routines: CHIEF_ROUTINES,
    screenKind: 'desktop',
  },
  {
    id: 'sales-outbound',
    name: 'Sales Outbound',
    title: 'Sales',
    description:
      'Works the pipeline overnight: researches the prospects worth a look, pulls their context together, and leaves sequences drafted for the morning.',
    avatar: 'sales-outbound',
    ink: '#F19D38',
    lastActivityMs: APP_NOW,
    lastEntryText: 'Typing…',
    transcript: [],
    routines: [SALES_ROUTINE],
    screenKind: 'crm-portal',
  },
  {
    id: 'inbox-manager',
    name: 'Inbox Manager',
    title: 'Email triage',
    description:
      'Keeps the inbox at zero: archives noise, drafts replies, and flags real fires.',
    avatar: 'inbox-manager',
    ink: '#6464EF',
    unread: true,
    unreadCount: 1,
    lastActivityMs: APP_NOW - 3 * HOUR,
    lastEntryText:
      'sent. inbox at zero, 5 drafts parked for tomorrow.',
    transcript: INBOX_TRANSCRIPT,
    routines: [],
    screenKind: 'desktop',
  },
  {
    id: 'account-manager',
    name: 'Account Manager',
    title: 'Named accounts',
    description:
      'Owns the named accounts: keeps the threads warm and knows what each one is waiting on.',
    avatar: 'account-manager',
    ink: '#885CF5',
    lastActivityMs: APP_NOW - 5 * HOUR,
    lastEntryText:
      "invite's out to vicky. globex note held in drafts.",
    transcript: ACCOUNT_TRANSCRIPT,
    routines: [],
    screenKind: 'desktop',
  },
  {
    id: 'talent-scout',
    name: 'Talent Scout',
    title: 'Sourcing',
    description:
      'Keeps the candidate pipeline moving: sources profiles, drafts intros, and shortlists who’s worth a call.',
    avatar: 'talent-scout',
    ink: '#3C82F6',
    lastActivityMs: APP_NOW - 8 * HOUR,
    lastEntryText:
      '3 intros drafted in your voice, held for your ok.',
    transcript: TALENT_TRANSCRIPT,
    routines: [],
    screenKind: 'desktop',
  },
  {
    id: 'expense-manager',
    name: 'Expense Manager',
    title: 'Receipts & reports',
    description:
      'Files receipts as they land, matches them to trips, and flags anything that doesn’t add up.',
    avatar: 'expense-manager',
    ink: '#ED712E',
    lastActivityMs: APP_NOW - 4 * HOUR,
    lastEntryText:
      'report filed. 9 receipts, nothing outstanding.',
    transcript: EXPENSE_TRANSCRIPT,
    routines: EXPENSE_ROUTINES,
    screenKind: 'desktop',
  },
  {
    id: 'offsite-crew',
    name: 'Offsite crew',
    title: 'Group room',
    description:
      'Shared room for wrapping up the offsite: recap, follow-ups, and thanks.',
    avatar: 'group',
    ink: '#54B9A6',
    isGroup: true,
    group: ['chief-of-staff', 'inbox-manager', 'account-manager'],
    lastActivityMs: APP_NOW - 6 * HOUR,
    lastEntryText:
      "that leaves the pipeline. i'd spin up a dedicated agent.",
    transcript: OFFSITE_TRANSCRIPT,
    routines: [],
    screenKind: 'desktop',
  },
]

export function createInitialSessions(): AppSession[] {
  return APP_SESSIONS.map(cloneSession)
}

export function createNewAgentSession(sequence: number): AppSession {
  return {
    id: `new-agent-${sequence}`,
    name: 'New agent',
    title: 'New agent',
    description: 'A fresh Bot ready for its first task.',
    avatar: 'sales-outbound',
    ink: '#111110',
    lastActivityMs: Date.now(),
    lastEntryText: '',
    transcript: [],
    routines: [],
    screenKind: 'desktop',
    isDraft: true,
  }
}

export function cloneSession(session: AppSession): AppSession {
  return {
    ...session,
    transcript: session.transcript.map((entry) => ({ ...entry })),
    routines: session.routines.map((routine) => ({ ...routine })),
    group: session.group ? [...session.group] : undefined,
  }
}

export function sessionToAgent(
  session: AppSession,
  name = session.name,
): Agent {
  return {
    id: session.id as AgentId,
    name,
    preview: session.lastEntryText,
    timeLabel: formatSidebarTime(session.lastActivityMs),
    ink: session.ink,
    avatar: session.avatar,
    avatarShape: session.avatar,
    avatarColor: session.avatarColor,
    avatarUrl: session.avatarUrl,
    group: session.group,
    unread: session.unread,
  }
}

export function formatSidebarTime(timestampMs: number, now = APP_NOW) {
  const date = new Date(timestampMs)
  const nowDate = new Date(now)
  if (isSameDay(date, nowDate)) return formatClock(timestampMs)
  if (isYesterday(date, nowDate)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatTranscriptTime(timestampMs: number, now = APP_NOW) {
  const date = new Date(timestampMs)
  const nowDate = new Date(now)
  if (isSameDay(date, nowDate)) return formatClock(timestampMs)
  if (isYesterday(date, nowDate)) {
    return `Yesterday ${formatClock(timestampMs)}`
  }
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)} ${formatClock(timestampMs)}`
}

function formatClock(timestampMs: number) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestampMs))
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function isYesterday(date: Date, now: Date) {
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  return isSameDay(date, yesterday)
}

export function entryPreview(entry: TranscriptEntry | undefined) {
  if (!entry) return ''
  if (entry.kind === 'agent-message' || entry.kind === 'user-message') {
    return entry.content
      .replaceAll(/[*_`#|]/g, '')
      .replaceAll(/\n+/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
  }
  if (entry.kind === 'system' && entry.event.type === 'created-routine') {
    return `Created routine ${entry.event.name}`
  }
  return ''
}

export function sessionPreview(
  session: AppSession,
  extras: TranscriptEntry[],
) {
  const last = extras.at(-1)
  return entryPreview(last) || session.lastEntryText
}

export function sessionActivityMs(
  session: AppSession,
  extras: TranscriptEntry[],
) {
  return transcriptTimestamp(extras.at(-1)) ?? session.lastActivityMs
}

export function isSessionMatch(
  session: AppSession,
  query: string,
  name = session.name,
) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    name.toLowerCase().includes(needle) ||
    session.lastEntryText.toLowerCase().includes(needle)
  )
}

export function titleFromMessage(message: string) {
  const clean = message
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/[^\p{L}\p{N} '’-]/gu, '')
    .trim()
  if (!clean) return 'New agent'
  const words = clean.split(' ').slice(0, 4).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function replyForSession(session: AppSession, message: string) {
  const text = message.toLowerCase()
  if (text.includes('routine') || text.includes('schedule')) {
    return 'It runs at **8:30am** on weekdays from now on. You can change the time or turn it off from my routines list.'
  }
  if (text.includes('remind')) {
    return "Scheduled. I'll nudge you right on time. Anything else while I'm at it?"
  }
  if (session.isGroup) {
    return "On it. I'll loop the crew in and come back with the next step."
  }
  switch (session.id) {
    case 'chief-of-staff':
      return "On it. I'll keep the rest of the day moving and come back if something needs your call."
    case 'inbox-manager':
      return "On it. I'll keep the inbox at zero and hold anything sensitive for your read."
    case 'account-manager':
      return "On it. I'll watch the account thread and hold external sends until you approve."
    case 'talent-scout':
      return "On it. I'll keep sourcing quietly and hold outreach for your ok."
    case 'expense-manager':
      return "On it. I'll reconcile the receipts and flag anything that doesn't line up."
    case 'sales-outbound':
      return "On it. I'll take this from here and come back when there's something for you to look at."
    default:
      return "On it. I'll take this from here and come back when there's something for you to look at."
  }
}

export function uniqueEntryId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function timeSince(timestampMs: number) {
  return Math.max(0, Date.now() - timestampMs)
}

export function transcriptTimestamp(entry: TranscriptEntry | undefined) {
  return entry && 'timestampMs' in entry ? entry.timestampMs : undefined
}

export { MINUTE }
