import type { Agent } from '../types'

export const AGENTS: Agent[] = [
  {
    id: 'chief-of-staff',
    name: 'Chief',
    preview: 'booked the venue and sent the confirmation around.',
    timeLabel: 'Yesterday',
    ink: '#54B9A6',
    avatar: 'chief',
  },
  {
    id: 'sales-outbound',
    name: 'New agent',
    preview: 'Typing…',
    timeLabel: '3:26 AM',
    ink: '#F19D38',
    avatar: 'sales-outbound',
  },
  {
    id: 'inbox-manager',
    name: 'Inbox Manager',
    preview: 'sent. inbox at zero, 5 drafts parked for tomorrow.',
    timeLabel: '12:26 AM',
    ink: '#6464EF',
    avatar: 'inbox-manager',
    unread: true,
  },
  {
    id: 'account-manager',
    name: 'Account Manager',
    preview: "invite's out to vicky. globex note held in drafts.",
    timeLabel: 'Yesterday',
    ink: '#885CF5',
    avatar: 'account-manager',
  },
  {
    id: 'talent-scout',
    name: 'Talent Scout',
    preview: '3 intros drafted in your voice, held for your ok.',
    timeLabel: 'Yesterday',
    ink: '#3C82F6',
    avatar: 'talent-scout',
  },
  {
    id: 'expense-manager',
    name: 'Expense Manager',
    preview: 'report filed. 9 receipts, nothing outstanding.',
    timeLabel: 'Yesterday',
    ink: '#ED712E',
    avatar: 'expense-manager',
  },
  {
    id: 'offsite-crew',
    name: 'Offsite crew',
    preview: "that leaves the pipeline. i'd spin up a dedicated agent.",
    timeLabel: 'Yesterday',
    ink: '#54B9A6',
    avatar: 'group',
    group: ['chief-of-staff', 'inbox-manager', 'account-manager'],
  },
]

export const AGENT_BY_NAME: Record<string, Agent> = Object.fromEntries(
  AGENTS.map((agent) => [agent.name, agent]),
)

export const ACTIVE_AGENT = AGENTS.find((agent) => agent.id === 'sales-outbound')!
