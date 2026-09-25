/**
 * Where a meta agent's notes go, and which options say so.
 *
 * A meta agent configures a conversation rather than working on the project, so its notes belong to the
 * session rather than to the project's shared folder. Three option builders exist because three callers
 * need different parts of that: the request-context options, the same plus the actor whose rules apply,
 * and the props the first user message needs — which include the notes folders only where they are worth
 * naming, and only the conversation's own folder for a project conversation.
 */

import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import { formatMetaAgentNotesDirectoryInstruction } from "../prompts/user-info-sections.ts"

export interface MetaAgentNotesConfig {
  readonly notesSessionId?: string | undefined
  readonly conversationId?: string | undefined
  readonly featureFlags?: unknown
  readonly actorIdentity?: { readonly email: string } | undefined
  readonly enableAgentNotes?: boolean | undefined
}

export { formatMetaAgentNotesDirectoryInstruction }

export function isMetaAgentNotesEnabled(featureFlags: unknown): boolean {
  return typeof featureFlags === "object" && featureFlags !== null &&
    "metaAgentNotes" in featureFlags && (featureFlags as { metaAgentNotes?: unknown }).metaAgentNotes === true
}

export function buildRequestContextNotesOptions(config: MetaAgentNotesConfig): {
  readonly notesSessionId: string | undefined
  readonly metaAgentNotesEnabled: boolean
} {
  return {
    notesSessionId: config.notesSessionId ?? config.conversationId,
    metaAgentNotesEnabled: isMetaAgentNotesEnabled(config.featureFlags),
  }
}

export function buildRequestContextOptions(config: MetaAgentNotesConfig): {
  readonly notesSessionId: string | undefined
  readonly metaAgentNotesEnabled: boolean
  readonly actorIdentity: { readonly email: string } | undefined
} {
  return { ...buildRequestContextNotesOptions(config), actorIdentity: config.actorIdentity }
}

export function buildUserInfoAgentNotesProps(
  config: MetaAgentNotesConfig,
  mode: AgentMode,
  env: {
    readonly agentConversationNotesFolder?: string | undefined
    readonly agentSharedNotesFolder?: string | undefined
  } | undefined,
): {
  readonly notesSessionId: string | undefined
  readonly metaAgentNotesEnabled: boolean
  readonly agentConversationNotesFolder?: string | undefined
  readonly agentSharedNotesFolder?: string | undefined
} {
  const includeAgentNotesPaths = mode === AgentMode.PROJECT || config.enableAgentNotes !== false
  const baseProps = buildRequestContextNotesOptions(config)
  if (!includeAgentNotesPaths) return baseProps
  // A project conversation has no shared notes of its own to name.
  if (mode === AgentMode.PROJECT) {
    return { ...baseProps, agentConversationNotesFolder: env?.agentConversationNotesFolder }
  }
  return {
    ...baseProps,
    agentSharedNotesFolder: env?.agentSharedNotesFolder,
    agentConversationNotesFolder: env?.agentConversationNotesFolder,
  }
}
