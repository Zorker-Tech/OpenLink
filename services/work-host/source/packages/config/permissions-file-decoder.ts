import { parse } from "jsonc-parser"
import { parsePermissionsAutoRunConfig } from "./project-permissions-file-provider.ts"
import type { DecodedPermissionsFile, PermissionsAutoRunInstructions } from "./permissions-file-contracts.ts"

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function propertyIgnoringCase(record: Record<string, unknown>, name: string): unknown {
  const expected = name.toLowerCase()
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === expected) return record[key]
  }
  return undefined
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function readAutoRunInstructions(value: unknown): PermissionsAutoRunInstructions {
  const parsed = parsePermissionsAutoRunConfig(value)
  return {
    allowInstructions: parsed?.allowInstructions ?? [],
    blockInstructions: parsed?.blockInstructions ?? [],
  }
}

export function decodePermissionsFile(source: string): DecodedPermissionsFile | undefined {
  const record = objectValue(parse(source) as unknown)
  if (record === undefined) return undefined

  const mcpRules = stringItems(propertyIgnoringCase(record, "mcpAllowlist"))
  const shellRules = stringItems(propertyIgnoringCase(record, "terminalAllowlist"))
  const reviewPolicy = propertyIgnoringCase(record, "autoReview")
    ?? propertyIgnoringCase(record, "autoRun")
  const instructions = readAutoRunInstructions(reviewPolicy)
  if (
    mcpRules.length === 0
    && shellRules.length === 0
    && instructions.allowInstructions.length === 0
    && instructions.blockInstructions.length === 0
  ) return undefined

  return {
    permissions: {
      allow: [
        ...shellRules.map((command) => `Shell(${command})`),
        ...mcpRules.map((server) => `Mcp(${server})`),
      ],
      deny: [],
    },
    autoRunInstructions: instructions,
  }
}
