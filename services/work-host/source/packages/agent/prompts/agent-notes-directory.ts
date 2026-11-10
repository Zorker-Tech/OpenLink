import path from "node:path";

interface AgentNotesDirectoryRequest {
  readonly metaAgentNotesEnabled?: boolean | undefined;
  readonly agentConversationNotesFolder?: string | undefined;
  readonly notesSessionId?: string | undefined;
  readonly env?: { readonly projectFolder?: string | undefined } | undefined;
}

const NOTES_DIRECTORY_NAME = "agent-notes";

function configuredDirectory(request: AgentNotesDirectoryRequest): string | undefined {
  const folder = request.agentConversationNotesFolder;
  return folder && folder.length > 0 ? folder : undefined;
}

function sessionDirectory(request: AgentNotesDirectoryRequest): string | undefined {
  const sessionId = request.notesSessionId;
  const projectRoot = request.env?.projectFolder;
  if (!sessionId || sessionId.length === 0 || !projectRoot || projectRoot.length === 0) return undefined;
  return path.join(projectRoot, NOTES_DIRECTORY_NAME, sessionId);
}

export function resolveAgentNotesDirectory(request: AgentNotesDirectoryRequest): string | undefined {
  if (request.metaAgentNotesEnabled !== true) return undefined;
  return configuredDirectory(request) ?? sessionDirectory(request);
}
