/**
 * Where a meta agent keeps its notes.
 *
 * A meta agent writes notes about the conversation it is configuring rather than about the project, so
 * its notes belong in a folder of their own instead of the project's shared one. The folder is either
 * already decided — the conversation's own notes folder — or has to be derived from the session and the
 * project it belongs to. Nothing is derived when the notes are not enabled for a meta agent at all.
 */

import path from "node:path"

export function resolveAgentNotesDirectory(props: {
  readonly metaAgentNotesEnabled?: boolean | undefined
  readonly agentConversationNotesFolder?: string | undefined
  readonly notesSessionId?: string | undefined
  readonly env?: { readonly projectFolder?: string | undefined } | undefined
}): string | undefined {
  if (props.metaAgentNotesEnabled !== true) return undefined
  const conversationNotesFolder = props.agentConversationNotesFolder
  if (conversationNotesFolder && conversationNotesFolder.length > 0) return props.agentConversationNotesFolder
  const notesSessionId = props.notesSessionId
  const projectFolder = props.env?.projectFolder
  if (notesSessionId && notesSessionId.length > 0 && projectFolder && projectFolder.length > 0) {
    return path.join(projectFolder, "agent-notes", notesSessionId)
  }
  return undefined
}
