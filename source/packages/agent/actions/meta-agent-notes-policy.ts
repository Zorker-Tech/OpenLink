/** Resolves which note folders belong in request-context and user-info options. */

import { SlateMode, type SlateMode as SlateModeValue } from "../mode-processing.ts"
import { formatMetaAgentNotesDirectoryInstruction } from "../prompts/user-info-notes-section.ts"
import type {
  MetaAgentNotesConfig,
  RequestContextNotesOptions,
  UserInfoAgentNotesProps,
} from "./meta-agent-notes-contracts.ts"

export { formatMetaAgentNotesDirectoryInstruction }

export function isMetaAgentNotesEnabled(flags: unknown): boolean {
  if (flags === null || typeof flags !== "object") return false
  return "metaAgentNotes" in flags && (flags as { readonly metaAgentNotes?: unknown }).metaAgentNotes === true
}

export function buildRequestContextNotesOptions(config: MetaAgentNotesConfig): RequestContextNotesOptions {
  return {
    notesSessionId: config.notesSessionId ?? config.conversationId,
    metaAgentNotesEnabled: isMetaAgentNotesEnabled(config.featureFlags),
  }
}

export function buildRequestContextOptions(config: MetaAgentNotesConfig): RequestContextNotesOptions & {
  readonly actorIdentity: { readonly email: string } | undefined
} {
  return {
    ...buildRequestContextNotesOptions(config),
    actorIdentity: config.actorIdentity,
  }
}

function noteFoldersFor(
  config: MetaAgentNotesConfig,
  mode: SlateModeValue,
  environment: {
    readonly agentConversationNotesFolder?: string | undefined
    readonly agentSharedNotesFolder?: string | undefined
  } | undefined,
): Pick<UserInfoAgentNotesProps, "agentConversationNotesFolder" | "agentSharedNotesFolder"> | undefined {
  const isProject = mode === SlateMode.PROJECT
  if (!isProject && config.enableAgentNotes === false) return undefined

  return isProject
    ? { agentConversationNotesFolder: environment?.agentConversationNotesFolder }
    : {
      agentConversationNotesFolder: environment?.agentConversationNotesFolder,
      agentSharedNotesFolder: environment?.agentSharedNotesFolder,
    }
}

export function buildSlateUserInfoAgentNotesProps(
  config: MetaAgentNotesConfig,
  mode: SlateModeValue,
  environment: {
    readonly agentConversationNotesFolder?: string | undefined
    readonly agentSharedNotesFolder?: string | undefined
  } | undefined,
): UserInfoAgentNotesProps {
  const base = buildRequestContextNotesOptions(config)
  const folders = noteFoldersFor(config, mode, environment)
  return folders === undefined ? base : { ...base, ...folders }
}
