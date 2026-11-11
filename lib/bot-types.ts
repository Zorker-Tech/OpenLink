import type { BotTranscriptEntry } from '@/lib/bot-transcript'
import type { BotConfirmationRequest } from '@/lib/bot-confirmations'

export type BotRuntimeStatus = 'pending' | 'provisioning' | 'ready' | 'failed'

export interface BotSummary {
  id: string
  userId: string
  workspaceId: string
  projectId: string | null
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
}

export interface BotDetail extends BotSummary {
  transcript: BotTranscriptEntry[]
  runtimeReady: boolean
  pendingConfirmations: BotConfirmationRequest[]
}
