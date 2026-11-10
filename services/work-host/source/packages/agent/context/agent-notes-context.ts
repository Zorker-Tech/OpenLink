export interface AgentNotesPromptInput {
  readonly isProjectConversation: boolean
  readonly enableAgentNotes: boolean
  readonly metaAgentNotes: boolean
  readonly conversationNotesListing?: string | undefined
  readonly sharedNotesListing?: string | undefined
}

export interface AgentNotesTextContent {
  readonly type: "text"
  readonly text: string
}

function renderListing(title: string, listing: string | undefined): string {
  return listing ? `\n${title}:\n${listing}\n` : ""
}

function hasAnyListing(input: AgentNotesPromptInput): boolean {
  return Boolean(input.conversationNotesListing || input.sharedNotesListing)
}

export function renderAgentNotesContext(input: AgentNotesPromptInput): AgentNotesTextContent | undefined {
  if (input.isProjectConversation || !input.enableAgentNotes || input.metaAgentNotes || !hasAnyListing(input)) {
    return undefined
  }

  const text = [
    "<agent_notes>\nAgent notes for this conversation:\n",
    renderListing("Conversation notes", input.conversationNotesListing),
    renderListing("Shared notes", input.sharedNotesListing),
    "</agent_notes>",
  ].join("")

  return { type: "text", text }
}
