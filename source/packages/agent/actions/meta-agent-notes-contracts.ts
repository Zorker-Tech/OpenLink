/** Slate-owned inputs and results for session-scoped note options. */

export interface MetaAgentNotesConfig {
  readonly notesSessionId?: string | undefined
  readonly conversationId?: string | undefined
  readonly featureFlags?: unknown
  readonly actorIdentity?: { readonly email: string } | undefined
  readonly enableAgentNotes?: boolean | undefined
}

export interface RequestContextNotesOptions {
  readonly notesSessionId: string | undefined
  readonly metaAgentNotesEnabled: boolean
}

export interface UserInfoAgentNotesProps extends RequestContextNotesOptions {
  readonly agentConversationNotesFolder?: string | undefined
  readonly agentSharedNotesFolder?: string | undefined
}
