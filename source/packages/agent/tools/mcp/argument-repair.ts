/**
 * Reading the arguments a model sent for an MCP tool when they are not quite JSON.
 *
 * A model writing a tool call by hand produces almost-JSON: a trailing comma before the closing brace, a
 * truncated blob, Python's single quotes, or — most often — the tool's own parameter markup leaked into
 * the argument it belongs to, because the model wrote the call the way it was trained to write it rather
 * than the way the schema asks. The call is worth repairing rather than rejecting: the model meant
 * something specific, and a round trip to ask again costs more than reading it correctly.
 *
 * The repairs are deliberately conservative. A blob with two readings is refused rather than guessed at,
 * since the two readings would call the tool differently. Markup is only stripped when it names exactly
 * one parameter — the one being read — because otherwise the argument is not the thing that leaked.
 * Duplicate keys are refused outright: JSON parsers keep the last one, and the model's intent is not
 * recoverable from that.
 */

export type JsonToken =
  | { readonly kind: "string"; readonly raw: string; readonly index: number }
  | { readonly kind: "punctuation"; readonly char: string; readonly index: number }

/** The tokens that matter for structure: strings (with their escapes) and the punctuation between them. */
export function* jsonTokens(text: string, start: number): Generator<JsonToken> {
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (char === '"') {
      const openIndex = index
      let escaped = false
      index++
      while (index < text.length) {
        const inner = text[index]!
        if (escaped) escaped = false
        else if (inner === "\\") escaped = true
        else if (inner === '"') break
        index++
      }
      yield { kind: "string", raw: text.slice(openIndex, index + 1), index: openIndex }
    } else if (char === "{" || char === "}" || char === "[" || char === "]" || char === ":" || char === ",") {
      yield { kind: "punctuation", char, index }
    }
  }
}

const decodeStringLiteral = (raw: string): string => {
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === "string" ? decoded : raw
  } catch {
    return raw
  }
}

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A key written twice in one object is refused, because which one was meant is not recoverable. */
export const namesAKeyTwice = (text: string): boolean => {
  const containers: Array<"object" | "array"> = []
  const keysPerObject: Array<Set<string>> = []
  let pendingString: string | undefined
  for (const token of jsonTokens(text, 0)) {
    if (token.kind === "string") {
      pendingString = token.raw
      continue
    }
    switch (token.char) {
      case "{":
        containers.push("object")
        keysPerObject.push(new Set())
        break
      case "[":
        containers.push("array")
        break
      case "}":
        if (containers.pop() === "object") keysPerObject.pop()
        break
      case "]":
        containers.pop()
        break
      case ":":
        if (containers[containers.length - 1] === "object" && pendingString !== undefined) {
          const key = decodeStringLiteral(pendingString)
          const seen = keysPerObject[keysPerObject.length - 1]
          if (seen !== undefined) {
            if (seen.has(key)) return true
            seen.add(key)
          }
        }
        break
      default:
        break
    }
    pendingString = undefined
  }
  return false
}

const parseWholeObject = (text: string): Record<string, unknown> | undefined =>
  namesAKeyTwice(text) ? undefined : parseJsonObject(text)

const decodeLeadingJsonObject = (blob: string): { readonly value: Record<string, unknown>; readonly rest: string } | undefined => {
  const start = blob.indexOf("{")
  if (start < 0) return undefined
  let depth = 0
  for (const token of jsonTokens(blob, start)) {
    if (token.kind !== "punctuation") continue
    if (token.char === "{") {
      depth++
    } else if (token.char === "}" && --depth === 0) {
      const value = parseJsonObject(blob.slice(start, token.index + 1))
      return value === undefined ? undefined : { value, rest: blob.slice(token.index + 1) }
    }
  }
  return undefined
}

const structuralClosingBraces = (blob: string, start: number): number[] => {
  const out: number[] = []
  for (const token of jsonTokens(blob, start)) {
    if (token.kind === "punctuation" && token.char === "}") out.push(token.index)
  }
  return out
}

/** The markup a model's own tool-call format uses, which sometimes leaks into an argument. */
export const leakedParameter = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?=<(?:antml:)?parameter\b|<\/|$)/gi

const readLeakedParameters = (markup: string): Record<string, string> | undefined => {
  const fields: Record<string, string> = {}
  for (const match of markup.matchAll(leakedParameter)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined && value.trim() !== "") fields[name] = value.trim()
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

const READING_SEARCH_BUDGET = 250_000

/** Every faithful reading of a blob, so a blob with more than one can be refused rather than guessed. */
const faithfulReadings = (blob: string): Record<string, unknown>[] | undefined => {
  const start = blob.indexOf("{")
  if (start < 0) return []
  const closingBraces = structuralClosingBraces(blob, start)
  if (closingBraces.length * blob.length > READING_SEARCH_BUDGET) return undefined
  const byFingerprint = new Map<string, Record<string, unknown>>()
  const add = (value: Record<string, unknown> | undefined): void => {
    if (value === undefined) return
    const fingerprint = JSON.stringify(value)
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, value)
  }
  const decoded = decodeLeadingJsonObject(blob)
  const leading = decoded !== undefined && !namesAKeyTwice(blob.slice(start, blob.length - decoded.rest.length))
    ? decoded
    : undefined
  const tail = leading?.rest.trim() ?? ""
  if (leading !== undefined && /^[\s,\]}]*$/.test(tail)) add(leading.value)
  // Dropping a stray closing brace is the other common shape, so each of them is tried.
  for (const index of closingBraces) add(parseWholeObject(blob.slice(start, index) + blob.slice(index + 1)))
  return [...byFingerprint.values()]
}

export interface ParsedMcpArguments {
  readonly args: Record<string, unknown>
  readonly repaired: boolean
  readonly envelopeFields?: Record<string, string>
}

export const parseArgumentsLeniently = (blob: string): ParsedMcpArguments | undefined => {
  const direct = parseJsonObject(blob)
  if (direct !== undefined) return { args: direct, repaired: false }
  const readings = faithfulReadings(blob)
  if (readings === undefined || readings.length > 1) return undefined
  if (readings.length === 1) return { args: readings[0]!, repaired: true }
  const decoded = decodeLeadingJsonObject(blob)
  const leaked = decoded === undefined ? undefined : readLeakedParameters(decoded.rest.trim())
  if (decoded === undefined || leaked === undefined) return undefined
  // Only a leaked description may be absorbed: anything else would be a parameter the call lost.
  return Object.keys(leaked).some(field => field !== "description")
    ? undefined
    : { args: decoded.value, repaired: true, envelopeFields: leaked }
}
