/**
 * Recognizing the platform's own files inside a workspace.
 *
 * Everything the platform keeps about a project lives under `.slate/projects/<workspace>/`, and some
 * of those files are addressed by shape rather than by path: a terminal file is `<id>.txt`, a tool
 * output is a `.txt` in `agent-tools`, a transcript page is anything under `agent-transcripts`. These
 * matchers are the one place that shape is written down.
 */

export const isAbsolutePath = (filePath: string): boolean =>
  filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")

export const MANAGED_PROJECTS_SEGMENT = ".slate/projects"

function splitPath(value: string): string[] {
  return value.split(/[/\\]/).filter(Boolean)
}

/** Matches `…/.slate/projects/<workspaceId>/<subdir>/<rest>` and returns what follows. */
function matchProjectSubdir(value: string, targetDir: string): { workspaceId: string; remainingPath: string[] } | null {
  const parts = splitPath(value)
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === ".slate" && parts[index + 1] === "projects" && parts[index + 3] === targetDir) {
      return { workspaceId: parts[index + 2] as string, remainingPath: parts.slice(index + 4) }
    }
  }
  return null
}

export const isAgentTranscriptPath = (value: string): boolean => matchProjectSubdir(value, "agent-transcripts") !== null

export const isTerminalsDirectory = (value: string): boolean => {
  const match = matchProjectSubdir(value, "terminals")
  return match !== null && match.remainingPath.length === 0
}

export const isAgentToolOutputFile = (filePath: string): boolean => {
  const match = matchProjectSubdir(filePath, "agent-tools")
  return match !== null && match.remainingPath.length === 1 && match.remainingPath[0]?.endsWith(".txt") === true
}

/** `<id>.txt` names a terminal; the id is what a caller needs to attach to it. */
export function extractTerminalId(filePath: string): { id: number } | null {
  const match = matchProjectSubdir(filePath, "terminals")
  if (match === null || match.remainingPath.length !== 1) return null
  const fileMatch = /^(\d+)\.txt$/.exec(match.remainingPath[0] as string)
  if (fileMatch?.[1] === undefined) return null
  const id = Number.parseInt(fileMatch[1], 10)
  return Number.isNaN(id) ? null : { id }
}

export const isTerminalFilePath = (filePath: string): boolean => extractTerminalId(filePath) !== null

/** A name that is safe to use as a file name on every platform we run on. */
export const sanitizeFilename = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_")
