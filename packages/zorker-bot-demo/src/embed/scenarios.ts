import type { AppSession } from '../app/data'
import type {
  ActivityEntry,
  AgentMessageEntry,
  ConfirmationEntry,
  SystemEntryData,
  UserMessageEntry,
} from '../types'

export type OpenLinkDemoScenario = 'computer' | 'team' | 'routine'

const startTime = Date.UTC(2026, 5, 16, 9)
const minute = 60_000

export function message(kind: 'agent-message', id: string, content: string, author?: string): AgentMessageEntry
export function message(kind: 'user-message', id: string, content: string): UserMessageEntry
export function message(kind: 'agent-message' | 'user-message', id: string, content: string, author?: string): AgentMessageEntry | UserMessageEntry {
  const entry = { id, content, timestampMs: startTime + minute }
  return kind === 'agent-message'
    ? { ...entry, kind, author: author ? { id: author, name: author } : undefined }
    : { ...entry, kind }
}

export function activity(id: string, label: string, detail: string): ActivityEntry {
  return { kind: 'activity', id, timestampMs: startTime + minute, activity: { label, detail, status: 'done' } }
}

export function confirmation(id: string, title: string, description: string): ConfirmationEntry {
  return {
    kind: 'confirmation', id, timestampMs: startTime + minute,
    confirmation: { id, title, message: description, status: 'pending' },
  }
}

export function scheduled(triggerDescription: string): SystemEntryData {
  return {
    kind: 'system', id: 'scheduled', timestampMs: startTime + minute,
    event: { type: 'created-routine', name: 'Open issue digest', triggerDescription },
  }
}

type Scenario = {
  label: string
  description: string
  prompt: string
  session: AppSession
  followUp: string
}

function session(id: OpenLinkDemoScenario, name: string, ink: string, intro: string, author?: string): AppSession {
  const mark = name[0]
  const avatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="10" fill="${ink}"/><text x="16" y="21" fill="#fff" font-family="system-ui,sans-serif" font-size="15" font-weight="650" text-anchor="middle">${mark}</text></svg>`
  return {
    id,
    name,
    title: name,
    ink,
    avatar: id,
    avatarUrl: `data:image/svg+xml,${encodeURIComponent(avatar)}`,
    description: intro,
    lastActivityMs: startTime,
    lastEntryText: intro,
    screenKind: 'desktop',
    isGroup: Boolean(author),
    transcript: [{ ...message('agent-message', 'welcome', intro, author), timestampMs: startTime }],
    routines: [],
  }
}

export const scenarios: Record<OpenLinkDemoScenario, Scenario> = {
  computer: {
    label: 'Use a computer',
    description: 'Give a Bot access to a tool and watch it work.',
    prompt: 'Check the support queue and tell me which tickets need a reply today.',
    session: session('computer', 'Support Bot', '#3b668d', 'I can scan the support queue and prioritize the tickets that need a human reply.'),
    followUp: 'The queue has three open tickets. The billing export and sign-in loop need a reply today. The audit-log question can wait until tomorrow.',
  },
  team: {
    label: 'Work as a team',
    description: 'Have two Bots prepare a handoff for your approval.',
    prompt: 'Put together a launch handoff for the new billing dashboard.',
    session: session('team', 'Launch Crew', '#795b9c', 'I can pull together the release notes and ask QA to check readiness.', 'Release Bot'),
    followUp: 'QA found one follow-up. The handoff includes a note about the CSV timeout and the owner for the fix.',
  },
  routine: {
    label: 'Schedule a routine',
    description: 'Turn a recurring request into a scheduled task.',
    prompt: 'Set up a weekly digest of open product issues.',
    session: session('routine', 'Project Bot', '#377a60', 'I can group open issues by area and surface anything without an owner.'),
    followUp: 'The digest summarizes open issues by area, with unassigned items at the top.',
  },
}

export const scenarioIds: OpenLinkDemoScenario[] = ['computer', 'team', 'routine']

export const tickets = [
  { id: 'OL-104', title: 'Billing export fails on large reports', priority: 'Today', detail: 'The export stops before the file is ready. The customer needs the report for today’s close.' },
  { id: 'OL-108', title: 'Sign-in loops after workspace switch', priority: 'Today', detail: 'The customer can sign in to their account but gets redirected when they switch workspaces.' },
  { id: 'OL-112', title: 'Audit log retention question', priority: 'Tomorrow', detail: 'The customer is planning next quarter’s review and asked for the current retention settings.' },
]

export const teamMembers = [
  { id: 'release', name: 'Release Bot' },
  { id: 'qa', name: 'QA Bot' },
]
