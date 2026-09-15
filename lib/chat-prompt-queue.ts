import type { AgentPromptAttachment } from '@/lib/agent-runtime/events'

export interface PromptModelSelection {
  providerId: string
  modelId: string
}

export interface QueuedChatPrompt {
  id: string
  text: string
  attachments: AgentPromptAttachment[]
  model: PromptModelSelection | null
  claimed: boolean
  createdAt: string
}

export interface ClaimedChatPrompt extends QueuedChatPrompt {
  claimToken: string
}
