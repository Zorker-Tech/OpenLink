import type {
  CreateChatSessionInput,
  CreateChatSessionResult,
  DeleteChatSessionResult,
  PendingAccessWrite,
  UpdateChatSessionAccessModeResult,
  UpdateChatSessionTitleResult,
} from '@/lib/desktop-api/action-types'
import type { AccessMode } from '@/lib/chat-sessions'

import { callDesktopAction } from '../api'

export type {
  CreateChatSessionInput,
  CreateChatSessionResult,
  DeleteChatSessionResult,
  PendingAccessWrite,
  UpdateChatSessionAccessModeResult,
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

export async function updateChatSessionAccessModeAction(input: {
  sessionId: string
  mode: AccessMode
}): Promise<UpdateChatSessionAccessModeResult> {
  return callDesktopAction<UpdateChatSessionAccessModeResult>('chat.updateAccessMode', input)
}

export async function listPendingAccessWritesAction(
  sessionId: string,
): Promise<{ confirmations: PendingAccessWrite[]; error: string | null }> {
  return callDesktopAction('chat.listPendingAccessWrites', { sessionId })
}

export async function approveAccessWriteAction(
  sessionId: string,
  confirmationId: string,
): Promise<{ ok: boolean; error: string | null }> {
  return callDesktopAction('chat.approveAccessWrite', { sessionId, confirmationId })
}

export async function deleteChatSessionAction(
  sessionId: string,
): Promise<DeleteChatSessionResult> {
  return callDesktopAction<DeleteChatSessionResult>('chat.delete', { sessionId })
}
