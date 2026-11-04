/** Add actionable, credential-safe details to a Git failure message. */
import { redactHttpUrlUserinfo } from "./url-redaction.ts"

const DIAGNOSTIC_MARKER = " [git: "
const HAS_GIT_DIAGNOSTICS = / \[git: ([^\]]*)\]/
const MAX_STDERR_CHARS = 2_048

interface GitFailureFields {
  readonly gitErrorCode?: unknown
  readonly exitCode?: unknown
  readonly stderr?: unknown
}

function readFailureFields(error: unknown): GitFailureFields | undefined {
  return typeof error === "object" && error !== null ? error as GitFailureFields : undefined
}

function diagnosticParts(fields: GitFailureFields): string[] {
  const parts: string[] = []
  if (typeof fields.gitErrorCode === "string" && fields.gitErrorCode.length > 0) {
    parts.push(`gitErrorCode=${fields.gitErrorCode}`)
  }
  if (typeof fields.exitCode === "number" && Number.isFinite(fields.exitCode)) {
    parts.push(`exitCode=${fields.exitCode}`)
  }
  return parts
}

function stderrDetail(fields: GitFailureFields, enabled: boolean): string | undefined {
  if (!enabled || typeof fields.stderr !== "string" || fields.stderr.length === 0) return undefined
  const redacted = redactHttpUrlUserinfo(fields.stderr)
  if (redacted.length <= MAX_STDERR_CHARS) return redacted
  return `${redacted.slice(0, MAX_STDERR_CHARS)}… [truncated to ${MAX_STDERR_CHARS} chars]`
}

export function appendGitDiagnostics(
  message: string,
  error: unknown,
  options?: { readonly includeStderr?: boolean | undefined },
): string {
  if (HAS_GIT_DIAGNOSTICS.test(message)) return message
  const fields = readFailureFields(error)
  if (fields === undefined) return message

  const details = diagnosticParts(fields)
  if (details.length === 0) return message

  const annotated = `${message}${DIAGNOSTIC_MARKER}${details.join(" ")}]`
  const stderr = stderrDetail(fields, options?.includeStderr === true)
  return stderr === undefined ? annotated : `${annotated}\n--- git stderr ---\n${stderr}`
}
