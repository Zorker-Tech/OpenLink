import type { AccessMode } from '@/lib/chat-sessions'

export interface PendingAccessWrite {
  id: string
  operation: string
  sql: string
  createdAt: string
}

export async function createChatSessionAction() {
  return { id: 'storybook-session', path: '/storybook/chat/storybook-session', fallback: false as const }
}

export async function deleteChatSessionAction() {
  return { ok: true as const, error: null }
}

export async function updateChatSessionTitleAction(input: { title: string }) {
  return { title: input.title, error: null }
}

export async function updateChatSessionAccessModeAction(input: { mode: AccessMode }) {
  return { mode: input.mode, error: null }
}

export async function listPendingAccessWritesAction() {
  return { confirmations: [] as PendingAccessWrite[], error: null }
}

export async function approveAccessWriteAction() {
  return { ok: true, error: null }
}
