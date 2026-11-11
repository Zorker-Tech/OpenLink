/**
 * Chat sessions are shared execution records for two product surfaces:
 * Code-mode chats and the hidden execution session behind a Bot. Keep the
 * discrimination rules in this dependency-free module so server accessors and
 * regression tests use exactly the same definition.
 */

export type ChatSessionSurface = 'code' | 'bot'

export interface ChatSessionSurfaceRecord {
  surface: string
}

export function isChatSessionSurface(value: unknown): value is ChatSessionSurface {
  return value === 'code' || value === 'bot'
}

export function isCodeChatSession<T extends ChatSessionSurfaceRecord>(
  session: T,
): session is T & { surface: 'code' } {
  return session.surface === 'code'
}

export function isBotChatSession<T extends ChatSessionSurfaceRecord>(
  session: T,
): session is T & { surface: 'bot' } {
  return session.surface === 'bot'
}
