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
  avatarShape: string
  avatarColor: string
  providerId: string | null
  modelId: string | null
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
