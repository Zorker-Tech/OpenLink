import type { BotTranscriptEntry } from '@/lib/bot-transcript'
import type { BotConfirmationRequest } from '@/lib/bot-confirmations'

export type BotRuntimeStatus = 'pending' | 'provisioning' | 'ready' | 'failed'

export interface BotRoutine {
  id: string
  name: string
  prompt: string
  triggerDescription: string
  schedule: string
  isEnabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
}

export interface BotInspirationCadence {
  meanIntervalMs: number
  minIntervalMs: number
  maxIntervalMs: number
  burstChance: number
}

export interface BotInspirationConfig {
  cadence: BotInspirationCadence
  lenses: string[]
  topics: string[]
}

export interface BotInspirationCandidate {
  title: string
  whyNow: string
  firstAction: string
  expectedValue: number
  estimatedCost: number
  novelty: number
  lens: string
}

export interface BotInspirationRecord {
  id: string
  createdAt: number
  trigger: 'stochastic' | 'manual' | 'nomination' | 'event'
  lens: string
  candidate: BotInspirationCandidate | null
  decision: 'woke' | 'skipped' | 'duplicate' | 'budget' | 'quiet' | 'cap' | 'unavailable' | 'error'
  detail?: string
  outcome?: 'acted' | 'silent' | 'failed'
  messageCount: number
  costUsd: number
  tokens: number
  feedback?: 'useful' | 'not-useful' | 'dismissed'
}

export interface BotInspirationState {
  version: number
  agentId: string
  config: BotInspirationConfig
  nextFireAt: number | null
  lastFiredAt: number | null
  ledger: BotInspirationRecord[]
  nominations: Array<{ id: string; fromAgentId: string; task: string; createdAt: number }>
  feedback: { useful: number; notUseful: number; dismissed: number }
  usage: { dayKey: string; usd: number; tokens: number; runs: number }
}

export interface BotGroupMemberSummary {
  id: string
  name: string
  workAgentId: string
  avatarShape: string
  avatarColor: string
  updatedAt: string
}

export interface BotSummary {
  id: string
  userId: string
  workspaceId: string
  projectId: string | null
  /**
   * The stable Bot execution key (`bot-<botId>`). It is opaque to the shared
   * substrate and is never a Code chat session.
   */
  runtimeKey: string
  /**
   * A legacy hidden Code session, kept only as migration input for Bots that
   * predate the Work-host control plane. New Bots never set it.
   */
  runtimeSessionId: string | null
  runtimeStatus: BotRuntimeStatus
  runtimeReadyAt: string | null
  runtimeLastError: string | null
  runtimeCheckedAt: string | null
  workAgentId: string
  name: string
  description: string
  /** User-authored identity instructions; empty means derive focus from context. */
  instructions: string
  avatarShape: string
  avatarColor: string
  providerId: string | null
  modelId: string | null
  /** Daily proactive-spend cap in USD; null means unlimited. */
  lastEntryText: string
  lastActivityAt: string
  lastViewedAt: string
  createdAt: string
  updatedAt: string
  unread: boolean
  kind: 'bot' | 'group'
  memberIds: string[]
  members: BotGroupMemberSummary[]
}

export interface BotDetail extends BotSummary {
  transcript: BotTranscriptEntry[]
  runtimeReady: boolean
  pendingConfirmations: BotConfirmationRequest[]
  routines: BotRoutine[]
}
