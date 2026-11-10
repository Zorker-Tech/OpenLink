/**
 * Reading what a model sent when it sent it as a string.
 *
 * Tool arguments arrive as JSON the model wrote, and a model that means `true` sometimes writes `"true"`
 * and one that means `42` sometimes writes `"42"`. Refusing those costs a round trip and teaches the
 * model nothing, so the values are read as what they were meant to be — and anything that is not
 * clearly one of those is left exactly as it came, so the schema's own error is what the model sees.
 */

import { z } from "zod"

const BOOLEAN_TEXT_VALUES: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["false", false],
])

function parsedBooleanText(value: string): boolean | undefined {
  return BOOLEAN_TEXT_VALUES.get(value)
}

export function preprocessLenientBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value
  return parsedBooleanText(value) ?? value
}

export function lenientBoolean<T extends z.ZodTypeAny = z.ZodBoolean>(schema?: T) {
  return z.preprocess(preprocessLenientBoolean, schema ?? z.boolean())
}

function parseNumberText(value: string): unknown {
  const normalized = value.trim()
  if (normalized.length === 0) return value

  const parsed = Number(normalized)
  return Number.isNaN(parsed) ? value : parsed
}

export function preprocessLenientNumber(value: unknown): unknown {
  if (typeof value === "number" || value === undefined) return value
  if (typeof value !== "string") return value
  return parseNumberText(value)
}

export function lenientNumber<T extends z.ZodTypeAny = z.ZodNumber>(schema: T = z.number() as unknown as T) {
  return z.preprocess(preprocessLenientNumber, schema)
}

/**
 * An enum value is matched case-insensitively, but only when exactly one option matches: two options
 * differing only in case are ambiguous, and guessing between them would be inventing an answer.
 */
function uniqueOptionForCaseFoldedValue<T extends string>(value: string, options: readonly T[]): T | undefined {
  const foldedValue = value.toLowerCase()
  let match: T | undefined

  for (const option of options) {
    if (option.toLowerCase() !== foldedValue) continue
    if (match !== undefined) return undefined
    match = option
  }

  return match
}

export function preprocessLenientEnumValue<T extends string>(value: unknown, options: readonly T[]): unknown {
  if (typeof value !== "string" || options.includes(value as T)) return value
  return uniqueOptionForCaseFoldedValue(value, options) ?? value
}

export function lenientEnum<T extends [string, ...string[]]>(schema: z.ZodEnum<T>) {
  return z.preprocess(value => preprocessLenientEnumValue(value, schema.options), schema)
}
