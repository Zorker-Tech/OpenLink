/** Slate-owned names and resource limits for values passed to a box. */

/** The environment variable a Slate box reads to know which names must be redacted. */
export const SLATE_BOX_SECRET_NAMES_ENV = "SLATE_BOX_SECRET_NAMES"

export const RESERVED_EXACT_BOX_SECRET_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "DISPLAY",
])

export const RESERVED_BOX_SECRET_PREFIXES = ["SLATE_", "__SLATE", "LD_"] as const

export const MAX_BOX_SECRET_COUNT = 100
export const MAX_BOX_SECRET_VALUE_LENGTH = 32 * 1024
export const MAX_BOX_SECRETS_TOTAL_LENGTH = 96 * 1024

/** Build the complete environment update expected by a Slate-owned box runtime. */
export function buildSlateBoxSecretsEnv(
  secrets: Readonly<Record<string, string>>,
): Record<string, string> {
  const names = Object.keys(secrets).sort()
  if (names.length === 0) return {}

  const environment: Record<string, string> = {}
  for (const name of names) environment[name] = secrets[name] ?? ""
  environment[SLATE_BOX_SECRET_NAMES_ENV] = names.join(",")
  return environment
}
