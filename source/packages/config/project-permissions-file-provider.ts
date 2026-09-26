/**
 * Reading the permissions a project's own configuration file grants.
 *
 * The file is JSON with comments, because it is written by hand and a person commenting out a rule is the
 * common case — so it is parsed by a reader that tolerates comments and trailing commas, and a file with
 * real errors in it is treated as absent rather than half-read. What the file may say is small on purpose:
 * an auto-run policy with instructions for what may run unattended and what may not. A field that is not a
 * list of strings is not a list, so it is read as absent rather than as an empty rule.
 */

import { parse, type ParseError } from "jsonc-parser"

export interface ParsedPermissionsAutoRunConfig {
  readonly allowInstructions: readonly string[] | undefined
  readonly blockInstructions: readonly string[] | undefined
}

export interface ProjectPermissionsFileConfig {
  readonly autoRun: ParsedPermissionsAutoRunConfig | undefined
}

function filterStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.filter((entry): entry is string => typeof entry === "string")
}

export function parsePermissionsAutoRunConfig(
  value: unknown,
): ParsedPermissionsAutoRunConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const autoRun = value as Record<string, unknown>
  return {
    allowInstructions: filterStrings(autoRun.allow_instructions),
    blockInstructions: filterStrings(autoRun.block_instructions),
  }
}

/** A file that does not parse is not a configuration, so it is reported as absent. */
export function parseProjectPermissionsFileConfig(
  raw: string,
): ProjectPermissionsFileConfig | undefined {
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined
  }
  const config = parsed as Record<string, unknown>
  // Both spellings are read, since the older one is still written by hand.
  const autoRunConfig = config.autoReview ?? config.autoRun
  return {
    autoRun: parsePermissionsAutoRunConfig(autoRunConfig),
  }
}
