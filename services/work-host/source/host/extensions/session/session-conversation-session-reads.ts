import type { ConversationSessionHandles, SessionConversationStateHost } from "./session-conversation-state-contracts.ts"

/** Own the session handles only for the duration of a detached read. */
export async function withConversationSession<Value>(
  host: Pick<SessionConversationStateHost, "openSession">,
  agentId: string,
  read: (session: ConversationSessionHandles) => Promise<Value>,
): Promise<Value> {
  const session = await host.openSession(agentId)
  try {
    return await read(session)
  } finally {
    await session.agentStore.dispose()
    session.db.close()
  }
}
