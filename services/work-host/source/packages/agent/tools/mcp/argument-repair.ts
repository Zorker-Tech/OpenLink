/**
 * Reading the arguments a model sent for an MCP tool when they are not quite JSON.
 *
 * A model writing a tool call by hand produces almost-JSON: a trailing comma before the closing brace, a
 * truncated blob, Python's single quotes, or — most often — the tool's own parameter markup leakedFields into
 * the argument it belongs to, because the model wrote the call the way it was trained to write it rather
 * than the way the schema asks. The call is worth repairing rather than rejecting: the model meant
 * something specific, and a round trip to ask again costs more than reading it correctly.
 *
 * The repairs are deliberately conservative. A blob with two candidateReadings is refused rather than guessed at,
 * since the two candidateReadings would call the tool differently. Markup is only stripped when it names exactly
 * one parameter — the one being read — because otherwise the argument is not the thing that leakedFields.
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
      const stringStart = index
      let inEscape = false
      index++
      while (index < text.length) {
        const innerCharacter = text[index]!
        if (inEscape) inEscape = false
        else if (innerCharacter === "\\") inEscape = true
        else if (innerCharacter === '"') break
        index++
      }
      yield { kind: "string", raw: text.slice(stringStart, index + 1), index: stringStart }
    } else if (char === "{" || char === "}" || char === "[" || char === "]" || char === ":" || char === ",") {
      yield { kind: "punctuation", char, index }
    }
  }
}

const decodedTextOf = (raw: string): string => {
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === "string" ? decoded : raw
  } catch {
    return raw
  }
}

const jsonObjectOrUndefined = (text: string): Record<string, unknown> | undefined => {
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
  const containerKinds: Array<"object" | "array"> = []
  const keysByObject: Array<Set<string>> = []
  let pendingKeyText: string | undefined
  for (const token of jsonTokens(text, 0)) {
    if (token.kind === "string") {
      pendingKeyText = token.raw
      continue
    }
    switch (token.char) {
      case "{":
        containerKinds.push("object")
        keysByObject.push(new Set())
        break
      case "[":
        containerKinds.push("array")
        break
      case "}":
        if (containerKinds.pop() === "object") keysByObject.pop()
        break
      case "]":
        containerKinds.pop()
        break
      case ":":
        if (containerKinds[containerKinds.length - 1] === "object" && pendingKeyText !== undefined) {
          const key = decodedTextOf(pendingKeyText)
          const seenKeys = keysByObject[keysByObject.length - 1]
          if (seenKeys !== undefined) {
            if (seenKeys.has(key)) return true
            seenKeys.add(key)
          }
        }
        break
      default:
        break
    }
    pendingKeyText = undefined
  }
  return false
}

const parseObjectIfSingleKeyed = (text: string): Record<string, unknown> | undefined =>
  namesAKeyTwice(text) ? undefined : jsonObjectOrUndefined(text)

const leadingObjectOf = (blob: string): { readonly value: Record<string, unknown>; readonly rest: string } | undefined => {
  const start = blob.indexOf("{")
  if (start < 0) return undefined
  let braceDepth = 0
  for (const token of jsonTokens(blob, start)) {
    if (token.kind !== "punctuation") continue
    if (token.char === "{") {
      braceDepth++
    } else if (token.char === "}" && --braceDepth === 0) {
      const value = jsonObjectOrUndefined(blob.slice(start, token.index + 1))
      return value === undefined ? undefined : { value, rest: blob.slice(token.index + 1) }
    }
  }
  return undefined
}

const closingBraceIndexes = (blob: string, start: number): number[] => {
  const indexes: number[] = []
  for (const token of jsonTokens(blob, start)) {
    if (token.kind === "punctuation" && token.char === "}") indexes.push(token.index)
  }
  return indexes
}

/** The markup a model's own tool-call format uses, which sometimes leaks into an argument. */
export const leakedParameter = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?=<(?:antml:)?parameter\b|<\/|$)/gi

const leakedFieldsOf = (markup: string): Record<string, string> | undefined => {
  const fieldsByName: Record<string, string> = {}
  for (const markupMatch of markup.matchAll(leakedParameter)) {
    const name = markupMatch[1]
    const value = markupMatch[2]
    if (name !== undefined && value !== undefined && value.trim() !== "") fieldsByName[name] = value.trim()
  }
  return Object.keys(fieldsByName).length > 0 ? fieldsByName : undefined
}

const READING_BUDGET = 250_000

/** Every faithful reading of a blob, so a blob with more than one can be refused rather than guessed. */
const readingsOf = (blob: string): Record<string, unknown>[] | undefined => {
  const start = blob.indexOf("{")
  if (start < 0) return []
  const closingIndexes = closingBraceIndexes(blob, start)
  if (closingIndexes.length * blob.length > READING_BUDGET) return undefined
  const readingsByFingerprint = new Map<string, Record<string, unknown>>()
  const add = (value: Record<string, unknown> | undefined): void => {
    if (value === undefined) return
    const readingFingerprint = JSON.stringify(value)
    if (!readingsByFingerprint.has(readingFingerprint)) readingsByFingerprint.set(readingFingerprint, value)
  }
  const decoded = leadingObjectOf(blob)
  const leading = decoded !== undefined && !namesAKeyTwice(blob.slice(start, blob.length - decoded.rest.length))
    ? decoded
    : undefined
  const trailer = leading?.rest.trim() ?? ""
  if (leading !== undefined && /^[\s,\]}]*$/.test(trailer)) add(leading.value)
  // Dropping a stray closing brace is the other common shape, so each of them is tried.
  for (const index of closingIndexes) add(parseObjectIfSingleKeyed(blob.slice(start, index) + blob.slice(index + 1)))
  return [...readingsByFingerprint.values()]
}

export interface ParsedMcpArguments {
  readonly args: Record<string, unknown>
  readonly repaired: boolean
  readonly envelopeFields?: Record<string, string>
}

export const parseArgumentsLeniently = (blob: string): ParsedMcpArguments | undefined => {
  const parsedDirectly = jsonObjectOrUndefined(blob)
  if (parsedDirectly !== undefined) return { args: parsedDirectly, repaired: false }
  const candidateReadings = readingsOf(blob)
  if (candidateReadings === undefined || candidateReadings.length > 1) return undefined
  if (candidateReadings.length === 1) return { args: candidateReadings[0]!, repaired: true }
  const decoded = leadingObjectOf(blob)
  const leakedFields = decoded === undefined ? undefined : leakedFieldsOf(decoded.rest.trim())
  if (decoded === undefined || leakedFields === undefined) return undefined
  // Only a leakedFields description may be absorbed: anything else would be a parameter the call lost.
  return Object.keys(leakedFields).some(field => field !== "description")
    ? undefined
    : { args: decoded.value, repaired: true, envelopeFields: leakedFields }
}
