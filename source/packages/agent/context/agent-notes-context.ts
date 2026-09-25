/**
 * The notes other agents left for whoever works on this problem next.
 *
 * A conversation can keep notes, and a project can keep shared notes, and both are files the agent could
 * read if it knew they existed. So the listings are given to it — but only where notes are the point: a
 * project conversation works differently, and a meta agent's notes are its own conversation rather than
 * context for the work, so it is given none of this.
 */

import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"

export interface AgentNotesPromptInput {
  readonly mode: AgentMode
  readonly enableAgentNotes: boolean
  readonly metaAgentNotes: boolean
  readonly conversationNotesListing?: string | undefined
  readonly sharedNotesListing?: string | undefined
}

export interface AgentNotesTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderAgentNotesContext({
  mode,
  enableAgentNotes,
  metaAgentNotes,
  conversationNotesListing,
  sharedNotesListing,
}: AgentNotesPromptInput): AgentNotesTextContent | undefined {
  if (mode !== AgentMode.PROJECT && enableAgentNotes && (conversationNotesListing || sharedNotesListing)) {
    if (metaAgentNotes) return undefined
    const parts = ["<agent_notes>\nAgent notes for this conversation:\n"]
    if (conversationNotesListing) {
      parts.push(`
Conversation notes:
${conversationNotesListing}
`)
    }
    if (sharedNotesListing) {
      parts.push(`
Shared notes:
${sharedNotesListing}
`)
    }
    parts.push("</agent_notes>")
    return { type: "text", text: parts.join("") }
  }
  return undefined
}
