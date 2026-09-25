/**
 * What a git failure adds to the message that carries it.
 *
 * A git error arrives as an exit code and a stderr that the caller usually never sees, so a failure
 * that says only "command failed" cannot be acted on. The error's own code and exit code are appended
 * in one bracketed suffix — once, since the message may already have been annotated — and the stderr
 * can be added behind a marker when the caller asked for it, capped and with credentials stripped
 * because it is going into a log.
 */

import { redactHttpUrlUserinfo } from "./url-redaction.ts"

const GIT_DIAGNOSTICS_PREFIX = " [git: "
const GIT_DIAGNOSTICS_RE = / \[git: ([^\]]*)\]/
const GIT_STDERR_LOG_CAP = 2_048

const capStderr = (stderr: string): string =>
  stderr.length <= GIT_STDERR_LOG_CAP ? stderr : `${stderr.slice(0, GIT_STDERR_LOG_CAP)}… [truncated to ${GIT_STDERR_LOG_CAP} chars]`

export function appendGitDiagnostics(
  message: string,
  error: unknown,
  options?: { includeStderr?: boolean },
): string {
  if (typeof error !== "object" || error === null || GIT_DIAGNOSTICS_RE.test(message)) return message
  const candidate = error as { gitErrorCode?: unknown; exitCode?: unknown; stderr?: unknown }
  const parts: string[] = []
  if (typeof candidate.gitErrorCode === "string" && candidate.gitErrorCode.length > 0) {
    parts.push(`gitErrorCode=${candidate.gitErrorCode}`)
  }
  if (typeof candidate.exitCode === "number" && Number.isFinite(candidate.exitCode)) {
    parts.push(`exitCode=${candidate.exitCode}`)
  }
  if (parts.length === 0) return message
  let annotated = `${message}${GIT_DIAGNOSTICS_PREFIX}${parts.join(" ")}]`
  if (options?.includeStderr === true && typeof candidate.stderr === "string" && candidate.stderr.length > 0) {
    annotated += `\n--- git stderr ---\n${capStderr(redactHttpUrlUserinfo(candidate.stderr))}`
  }
  return annotated
}
