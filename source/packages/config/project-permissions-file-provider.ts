/**
 * Reading the permissions a project's own configuration file grants.
 *
 * The file is JSON with comments, because it is written by hand and a person commenting out a rule is the
 * common case — so it is parsed by a reader that tolerates comments and trailing commas, and a file with
 * real errors in it is treated as absent rather than half-read. What the file may say is small on purpose:
 * an auto-run policy with instructions for what may run unattended and what may not. A field that is not a
 * list of strings is not a list, so it is read as absent rather than as an empty rule.
 */

import { parse, type ParseError } from "jsonc-parser";

export interface ParsedPermissionsAutoRunConfig {
  readonly allowInstructions: readonly string[] | undefined;
  readonly blockInstructions: readonly string[] | undefined;
}

export interface ProjectPermissionsFileConfig {
  readonly autoRun: ParsedPermissionsAutoRunConfig | undefined;
}

/** A configuration is an object; an array or a value is not one, however it was written. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The strings a list holds, or nothing at all when what was written is not a list. */
function stringsIn(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function parsePermissionsAutoRunConfig(value: unknown): ParsedPermissionsAutoRunConfig | undefined {
  if (!isRecord(value)) return undefined;
  return {
    allowInstructions: stringsIn(value["allow_instructions"]),
    blockInstructions: stringsIn(value["block_instructions"]),
  };
}

/**
 * A project's permissions file, read with its comments and trailing commas allowed.
 *
 * A file with a real error in it is reported as absent rather than half-read: a configuration that was meant to permit
 * something and does not is worse than no configuration at all.
 */
export function parseProjectPermissionsFileConfig(raw: string): ProjectPermissionsFileConfig | undefined {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed)) return undefined;
  // Both spellings are read, since the older one is still written by hand.
  return { autoRun: parsePermissionsAutoRunConfig(parsed["autoReview"] ?? parsed["autoRun"]) };
}
