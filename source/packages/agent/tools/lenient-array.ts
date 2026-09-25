/**
 * Reading an array a model sent as text when it is not quite JSON.
 *
 * A tool whose argument is a list gets that list as a string surprisingly often: the model writes the
 * array inside a quoted argument, or writes a single item where a list belongs, or — with its own
 * tool-call markup — writes the parameter tag inside the value. Each of those has one sensible reading,
 * so each is read, and anything with two readings is refused rather than guessed at.
 *
 * The reasons for refusing are reported rather than swallowed, because they are what a caller needs to
 * tell a model how to re-issue the call: a value that looks like several items, a truncated blob, a
 * leaked tag naming a different parameter, or plain corruption.
 */

import { z } from "zod"

import { jsonTokens, leakedParameter, namesAKeyTwice } from "./mcp/argument-repair.ts"

const parseWholeArray = (text: string): unknown[] | undefined => {
  if (namesAKeyTwice(text)) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Why a blob could not be read, in the terms a model can act on. */
const diagnose = (text: string): string => {
  if (namesAKeyTwice(text)) return "duplicate-key"
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? "unreachable" : `parsed-as-${typeof parsed}`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : ""
    if (/Unexpected end of (JSON input|data)/.test(message)) return "truncated"
    try {
      const requoted: unknown = JSON.parse(text.replace(/'/g, '"'))
      if (Array.isArray(requoted)) return "python-repr"
    } catch {
      // Fall through to the corruption verdict.
    }
    return "corrupt-json"
  }
}

/** The array that starts at the first bracket, and whatever followed it. */
const decodeLeadingJsonArray = (blob: string): { readonly value: unknown[]; readonly rest: string } | undefined => {
  const start = blob.indexOf("[")
  if (start < 0) return undefined
  let depth = 0
  for (const token of jsonTokens(blob, start)) {
    if (token.kind !== "punctuation") continue
    if (token.char === "[" || token.char === "{") {
      depth++
    } else if ((token.char === "]" || token.char === "}") && --depth === 0) {
      const value = parseWholeArray(blob.slice(start, token.index + 1))
      return value === undefined ? undefined : { value, rest: blob.slice(token.index + 1) }
    }
  }
  return undefined
}

/** A scalar with a comma or a line break in it was probably meant as several items. */
const looksMultiItem = (scalar: string): boolean => /,\s*\S/.test(scalar) || /\n\s*\S/.test(scalar)

type RepairResult =
  | { readonly ok: true; readonly value: unknown[]; readonly strategy: string }
  | { readonly ok: false; readonly reason: string }

const repairStringifiedArray = (value: string, field: string, itemsArePrimitive: boolean): RepairResult => {
  const trimmed = value.trim()
  if (trimmed === "") return { ok: false, reason: "empty" }
  const direct = parseWholeArray(trimmed)
  if (direct !== undefined) return { ok: true, value: direct, strategy: "clean-json" }

  const leaks = [...trimmed.matchAll(leakedParameter)]
  if (leaks.length > 0) {
    const names = leaks.map(match => match[1])
    const mine = leaks.filter(match => match[1] === field)
    // The markup is only the wrapper when it names this parameter and nothing else.
    if (mine.length === 1 && names.every(name => name === field)) {
      const inner = parseWholeArray((mine[0]?.[2] ?? "").trim())
      if (inner !== undefined) return { ok: true, value: inner, strategy: "strip-leaked-markup" }
    }
    return { ok: false, reason: `leaked-markup-unrecoverable(${[...new Set(names)].join("|")})` }
  }
  if (itemsArePrimitive && !/^[[{]/.test(trimmed)) {
    if (looksMultiItem(trimmed)) return { ok: false, reason: "scalar-looks-multi-item" }
    if (parseWholeArray(`[${trimmed}]`) === undefined) return { ok: true, value: [value], strategy: "wrap-scalar" }
  }
  if (trimmed.startsWith("[")) {
    // A complete array followed by nothing that carries content is the array, with a stray tail.
    const leading = decodeLeadingJsonArray(trimmed)
    if (leading !== undefined && /^[\s,\]}]*$/.test(leading.rest)) {
      return { ok: true, value: leading.value, strategy: "drop-contentless-tail" }
    }
  }
  return { ok: false, reason: diagnose(trimmed) }
}

function preprocessLenientArray(value: unknown, options: { readonly field: string; readonly primitiveItems?: boolean }): unknown {
  if (typeof value !== "string") return value
  const repair = repairStringifiedArray(value, options.field, options.primitiveItems === true)
  return repair.ok ? repair.value : value
}

export function lenientArray<T extends z.ZodTypeAny>(
  schema: T,
  options: { readonly field: string; readonly primitiveItems?: boolean },
): z.ZodEffects<T, z.output<T>, unknown> {
  return z.preprocess(value => preprocessLenientArray(value, options), schema)
}
