/**
 * Recognizing the platform's own files inside a workspace.
 *
 * Everything the platform keeps about a project lives under `.slate/projects/<workspace>/`, and some
 * of those files are addressed by shape rather than by path: a terminal file is `<id>.txt`, a tool
 * output is a `.txt` in `agent-tools`, a transcript page is anything under `agent-transcripts`. These
 * matchers are the one place that shape is written down.
 */

export { PROJECT_STORAGE_RELATIVE_PATH as MANAGED_PROJECTS_SEGMENT } from "./managed-project-path-contracts.ts";
export {
  hasManagedTerminalFile as isTerminalFilePath,
  hasManagedTranscriptDirectory as isAgentTranscriptPath,
  isAbsolutePath,
  isManagedTerminalDirectory as isTerminalsDirectory,
  isManagedToolOutput as isAgentToolOutputFile,
  terminalIdFromManagedPath as extractTerminalId,
} from "./managed-project-path-policy.ts";
export { filesystemSafeName as sanitizeFilename } from "./filename-safety.ts";
