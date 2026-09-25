/**
 * Reading what a model sent when it sent it as a string.
 *
 * Tool arguments arrive as JSON the model wrote, and a model that means `true` sometimes writes `"true"`
 * and one that means `42` sometimes writes `"42"`. Refusing those costs a round trip and teaches the
 * model nothing, so the values are read as what they were meant to be — and anything that is not
 * clearly one of those is left exactly as it came, so the schema's own error is what the model sees.
 */

import { z } from "zod"

export function preprocessLenientBoolean(value: unknown): unknown {
  if (value === "true") return true
  if (value === "false") return false
  return value
}

export function lenientBoolean<T extends z.ZodTypeAny = z.ZodBoolean>(schema?: T) {
  return z.preprocess(preprocessLenientBoolean, schema ?? z.boolean())
}

export function preprocessLenientNumber(value: unknown): unknown {
  if (value === undefined || typeof value === "number") return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return value
    const number = Number(trimmed)
    return Number.isNaN(number) ? value : number
  }
  return value
}

export function lenientNumber<T extends z.ZodTypeAny = z.ZodNumber>(schema: T = z.number() as unknown as T) {
  return z.preprocess(preprocessLenientNumber, schema)
}

/**
 * An enum value is matched case-insensitively, but only when exactly one option matches: two options
 * differing only in case are ambiguous, and guessing between them would be inventing an answer.
 */
export function preprocessLenientEnumValue<T extends string>(value: unknown, options: readonly T[]): unknown {
  if (typeof value !== "string" || options.includes(value as T)) return value
  const lower = value.toLowerCase()
  const matches = options.filter(option => option.toLowerCase() === lower)
  return matches.length === 1 ? matches[0] : value
}

export function lenientEnum<T extends [string, ...string[]]>(schema: z.ZodEnum<T>) {
  return z.preprocess(value => preprocessLenientEnumValue(value, schema.options), schema)
}
