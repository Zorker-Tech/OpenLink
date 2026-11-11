import type { TranscriptEntry } from '../types'
import {
  CHECKING_CONNECTIONS,
  COMPUTER_ASK,
  COMPUTER_INSTRUCTION,
  CONNECTED_SUMMARY,
  CONTEXT_MESSAGE,
  DONE_MESSAGE,
  DRAFTS_MESSAGE,
  GREETING,
  ROUTINE,
  SEND_MESSAGE,
  USER_REQUEST,
} from './copy'

export const FINAL_TRANSCRIPT: TranscriptEntry[] = [
  {
    kind: 'agent-message',
    id: 'so-1',
    content: GREETING,
    timestampMs: Date.now() - 48_000,
  },
  {
    kind: 'user-message',
    id: 'so-3',
    content: USER_REQUEST,
    timestampMs: Date.now() - 42_000,
  },
  {
    kind: 'system',
    id: 'so-rename',
    timestampMs: Date.now() - 42_000,
    event: { type: 'renamed', name: 'Sales Outbound' },
  },
  {
    kind: 'agent-message',
    id: 'so-4',
    content: CHECKING_CONNECTIONS,
    timestampMs: Date.now() - 42_000,
  },
  {
    kind: 'computer',
    id: 'so-5',
    instruction: COMPUTER_INSTRUCTION,
    ask: COMPUTER_ASK,
    status: 'done',
    screenKind: 'crm-portal',
  },
  {
    kind: 'agent-message',
    id: 'so-6',
    content: CONNECTED_SUMMARY,
    timestampMs: Date.now() - 30_000,
  },
  {
    kind: 'system',
    id: 'so-7',
    timestampMs: Date.now() - 24_000,
    event: {
      type: 'received-context',
      sources: [{ name: 'Account Manager' }, { name: 'Chief' }],
    },
  },
  {
    kind: 'agent-message',
    id: 'so-8',
    content: CONTEXT_MESSAGE,
    timestampMs: Date.now() - 24_000,
  },
  {
    kind: 'agent-message',
    id: 'so-9',
    content: DRAFTS_MESSAGE,
    timestampMs: Date.now() - 18_000,
  },
  {
    kind: 'user-message',
    id: 'so-10',
    content: SEND_MESSAGE,
    reactions: ['👍'],
    timestampMs: Date.now() - 12_000,
  },
  {
    kind: 'system',
    id: 'so-11',
    timestampMs: Date.now() - 12_000,
    event: { type: 'created-routine', ...ROUTINE },
  },
  {
    kind: 'agent-message',
    id: 'so-12',
    content: DONE_MESSAGE,
    timestampMs: Date.now() - 6_000,
  },
]
