import type {
  CreateChatSessionInput,
  CreateChatSessionResult,
  DeleteChatSessionResult,
  PendingAccessWrite,
  UpdateChatSessionTitleResult,
} from '@/lib/desktop-api/action-types'

import { callDesktopAction } from '../api'

export type {
  CreateChatSessionInput,
  CreateChatSessionResult,
  DeleteChatSessionResult,
  PendingAccessWrite,
  UpdateChatSessionTitleResult,
}

export async function createChatSessionAction(
  input: CreateChatSessionInput = {},
): Promise<CreateChatSessionResult> {
  return callDesktopAction<CreateChatSessionResult>('chat.create', input)
}

export async function updateChatSessionTitleAction(input: {
  sessionId: string
  title: string
}): Promise<UpdateChatSessionTitleResult> {
  return callDesktopAction<UpdateChatSessionTitleResult>('chat.updateTitle', input)
}

export async function listPendingAccessWritesAction(
  sessionId: string,
): Promise<{ confirmations: PendingAccessWrite[]; error: string | null }> {
  return callDesktopAction<{ confirmations: PendingAccessWrite[]; error: string | null }>('chat.listPendingAccessWrites', { sessionId })
}

export async function approveAccessWriteAction(
  sessionId: string,
  confirmationId: string,
): Promise<{ ok: boolean; error: string | null }> {
  return callDesktopAction<{ ok: boolean; error: string | null }>('chat.approveAccessWrite', { sessionId, confirmationId })
}

export async function deleteChatSessionAction(
  sessionId: string,
): Promise<DeleteChatSessionResult> {
  return callDesktopAction<DeleteChatSessionResult>('chat.delete', { sessionId })
}
