/**
 * Context-scoped logging.
 *
 * A logger never prints on its own: it hands an entry to the backend the *context* carries, which
 * is what lets a caller redirect or enrich logging for a whole subtree — one run, one request,
 * one Box — by installing a backend on that context and leaving every call site alone.
 */

import { createKey, type Context, type ContextKey } from "./context.ts"

export type ContextLogLevel = "debug" | "info" | "warn" | "error"

export interface ContextLogEntry {
  readonly level: ContextLogLevel
  readonly message: string
  readonly timestamp: Date
  /** Usually the context the entry belongs to; any other value is rendered as data. */
  readonly context?: unknown | undefined
  readonly error?: unknown | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
  /** The logger's own label, set by `createLogger`. */
  readonly scope?: string | undefined
}

export interface ContextLoggerBackend {
  log(context: Context, entry: ContextLogEntry): void
}

export interface ContextLogger {
  debug(context: Context, message: string, metadata?: Readonly<Record<string, unknown>>): void
  info(context: Context, message: string, metadata?: Readonly<Record<string, unknown>>): void
  warn(context: Context, message: string, metadata?: Readonly<Record<string, unknown>>): void
  error(context: Context, message: string, error: unknown, metadata?: Readonly<Record<string, unknown>>): void
}

/** Values that render as a placeholder instead of being expanded. */
interface InlineSummary {
  readonly kind: "summary"
  readonly summary: string
}

export interface InlineSerializerContext {
  readonly path: readonly (string | number)[]
  readonly depth: number
}

interface PrettyConsole {
  log(value: string): void
  warn(value: string): void
  error(value: string): void
}

export interface PrettyTerminalLoggerOptions {
  readonly indent?: number
  readonly maxDepth?: number
  readonly maxEntries?: number
  readonly maxArrayLength?: number
  readonly maxStringLength?: number
  readonly includeTimestamp?: boolean
  readonly includeContextPath?: boolean
  /** Last chance to replace a value before it is rendered — used to redact secrets. */
  readonly inlineSerializer?: (value: unknown, context: InlineSerializerContext) => unknown
  readonly useColors?: boolean
  readonly console?: PrettyConsole
}

interface RenderOptions {
  readonly indent: string
  readonly maxDepth: number
  readonly maxEntries: number
  readonly maxArrayLength: number
  readonly maxStringLength: number
  readonly includeTimestamp: boolean
  readonly includeContextPath: boolean
  readonly inlineSerializer: PrettyTerminalLoggerOptions["inlineSerializer"]
}

interface ColorPalette {
  readonly dim: (value: string) => string
  readonly gray: (value: string) => string
  readonly red: (value: string) => string
  readonly green: (value: string) => string
  readonly yellow: (value: string) => string
  readonly blue: (value: string) => string
  readonly magenta: (value: string) => string
  readonly cyan: (value: string) => string
  readonly bold: (value: string) => string
  readonly level: (level: ContextLogLevel, value: string) => string
}

const DEFAULT_INDENT = 2
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_MAX_ARRAY_LENGTH = 40
const DEFAULT_MAX_STRING_LENGTH = 200
const LEVEL_LABEL_WIDTH = 5

function shouldUseColors(useColors?: boolean): boolean {
  if (typeof useColors === "boolean") return useColors
  if (typeof process === "undefined") return false
  const env = process.env ?? {}
  if ("NO_COLOR" in env) return false
  if (env.TERM === "dumb") return false
  const forceColor = env.FORCE_COLOR
  if (forceColor === "1" || forceColor === "true") return true
  if (forceColor === "0") return false
  return Boolean(process.stdout?.isTTY)
}

function createColorPalette(enabled: boolean): ColorPalette {
  const reset = "\u001b[0m"
  const withCodes = (codes: readonly number[]) => (value: string): string =>
    enabled ? `\u001b[${codes.join(";")}m${value}${reset}` : value
  const base = {
    dim: withCodes([2]),
    gray: withCodes([90]),
    red: withCodes([31]),
    green: withCodes([32]),
    yellow: withCodes([33]),
    blue: withCodes([34]),
    magenta: withCodes([35]),
    cyan: withCodes([36]),
    bold: withCodes([1]),
  }
  const levelStyles: Record<ContextLogLevel, (value: string) => string> = {
    debug: base.magenta,
    info: base.blue,
    warn: base.yellow,
    error: withCodes([1, 31]),
  }
  return {
    ...base,
    level: (level, value) => {
      if (!Object.prototype.hasOwnProperty.call(levelStyles, level)) {
        throw new Error(`Unhandled log level: ${String(level)}`)
      }
      return levelStyles[level](value)
    },
  }
}

function resolveRenderOptions(options: PrettyTerminalLoggerOptions): RenderOptions {
  return {
    indent: " ".repeat(options.indent ?? DEFAULT_INDENT),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    includeTimestamp: options.includeTimestamp ?? true,
    includeContextPath: options.includeContextPath ?? true,
    inlineSerializer: options.inlineSerializer,
  }
}

/** `HH:MM:SS.mmm` — a log line's date is its day, so the date part is dropped. */
function formatTimestamp(timestamp: Date): string {
  return timestamp.toISOString().slice(11, 23)
}

function isContext(value: unknown): value is Context {
  return typeof value === "object" && value !== null && "getPath" in value &&
    typeof (value as { getPath?: unknown }).getPath === "function"
}

type ErrorLike = Record<PropertyKey, unknown> & {
  readonly name?: unknown
  readonly message?: unknown
  readonly stack?: unknown
  readonly cause?: unknown
}

function isErrorLike(value: unknown): value is ErrorLike {
  if (typeof value !== "object" || value === null) return false
  return "message" in value || "stack" in value || "name" in value || "cause" in value
}

function isInlineSummary(value: unknown): value is InlineSummary {
  return typeof value === "object" && value !== null &&
    (value as { kind?: unknown }).kind === "summary" &&
    typeof (value as { summary?: unknown }).summary === "string"
}

function truncateString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`
}

function applyInlineSerializer(
  value: unknown,
  options: RenderOptions,
  path: readonly (string | number)[],
  depth: number,
): unknown {
  if (!options.inlineSerializer) return value
  try {
    const serialized = options.inlineSerializer(value, { path, depth })
    return serialized === undefined ? value : serialized
  } catch {
    return value
  }
}

function formatInlineValue(
  input: unknown,
  options: RenderOptions,
  colors: ColorPalette,
  depth: number,
  seen: WeakSet<object>,
  path: readonly (string | number)[],
): string {
  const value = applyInlineSerializer(input, options, path, depth)
  if (isInlineSummary(value)) return colors.dim(`<${value.summary}>`)
  if (value === null) return colors.gray("null")
  if (value === undefined) return colors.gray("undefined")
  if (typeof value === "string") return colors.green(JSON.stringify(truncateString(value, options.maxStringLength)))
  if (typeof value === "number") return colors.yellow(String(value))
  if (typeof value === "boolean") return colors.magenta(String(value))
  if (typeof value === "bigint") return colors.yellow(`${value}n`)
  if (typeof value === "symbol") return colors.cyan(value.toString())
  if (typeof value === "function") return colors.dim(`[Function${value.name ? ` ${value.name}` : ""}]`)
  if (value instanceof Date) return colors.green(Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString())
  if (value instanceof RegExp) return colors.cyan(value.toString())
  if (isErrorLike(value)) return formatErrorSummary(value, options, colors, depth, seen, path)
  if (Array.isArray(value)) return formatInlineCollection(value, "array", options, colors, depth, seen, path)
  if (value instanceof ArrayBuffer) return colors.dim(`ArrayBuffer(${value.byteLength})`)
  if (ArrayBuffer.isView(value)) return colors.dim(`${value.constructor?.name ?? "TypedArray"}(${value.byteLength})`)
  if (value instanceof Map) return formatInlineCollection(value, "map", options, colors, depth, seen, path)
  if (value instanceof Set) return formatInlineCollection(value, "set", options, colors, depth, seen, path)
  return formatInlineCollection(value, "object", options, colors, depth, seen, path)
}

function formatErrorSummary(
  error: ErrorLike,
  options: RenderOptions,
  colors: ColorPalette,
  depth: number,
  seen: WeakSet<object>,
  path: readonly (string | number)[],
): string {
  if (seen.has(error)) return colors.dim("[Circular]")
  seen.add(error)
  const name = typeof error.name === "string" ? error.name : "Error"
  const message = typeof error.message === "string" ? error.message : ""
  let result = colors.red(message ? `${name}: ${message}` : name)
  if ("cause" in error && error.cause !== undefined) {
    const cause = formatInlineValue(error.cause, options, colors, depth + 1, seen, path.concat("cause"))
    result = `${result} ${colors.dim("cause=")}${cause}`
  }
  seen.delete(error)
  return result
}

type InlineCollectionKind = "array" | "set" | "map" | "object"

type InlineCollectionEntry =
  | { readonly kind: "value"; readonly value: unknown; readonly path: readonly (string | number)[] }
  | { readonly kind: "property"; readonly name: string; readonly value: unknown; readonly path: readonly (string | number)[] }
  | { readonly kind: "pair"; readonly key: unknown; readonly value: unknown; readonly path: readonly (string | number)[] }

function formatInlineCollection(
  value: object,
  kind: InlineCollectionKind,
  options: RenderOptions,
  colors: ColorPalette,
  depth: number,
  seen: WeakSet<object>,
  path: readonly (string | number)[],
): string {
  const depthLabel = kind === "map"
    ? `Map(${(value as Map<unknown, unknown>).size})`
    : kind === "object"
      ? `[${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}]`
      : `[Array(${kind === "set" ? (value as Set<unknown>).size : (value as readonly unknown[]).length})]`
  if (depth >= options.maxDepth) return colors.dim(depthLabel)
  if (seen.has(value)) return colors.dim("[Circular]")
  seen.add(value)

  let entries: InlineCollectionEntry[]
  let opening: string
  let closing: string
  switch (kind) {
    case "array":
      entries = (value as readonly unknown[]).map((entry, index) => ({ kind: "value", value: entry, path: path.concat(index) }))
      opening = "["
      closing = "]"
      break
    case "set":
      entries = Array.from((value as Set<unknown>).values(), (entry, index) => ({ kind: "value", value: entry, path: path.concat(index) }))
      opening = "["
      closing = "]"
      break
    case "map":
      entries = Array.from((value as Map<unknown, unknown>).entries(), ([key, entry]) => ({ kind: "pair", key, value: entry, path }))
      opening = "Map{"
      closing = "}"
      break
    case "object":
      entries = Object.entries(value).map(([name, entry]) => ({ kind: "property", name, value: entry, path: path.concat(name) }))
      opening = "{"
      closing = "}"
      break
  }

  if (entries.length === 0) {
    seen.delete(value)
    return colors.dim(`${opening}${closing}`)
  }
  const limit = Math.min(entries.length, kind === "array" || kind === "set" ? options.maxArrayLength : options.maxEntries)
  const items = entries.slice(0, limit).map((entry) => {
    if (entry.kind === "value") {
      return formatInlineValue(entry.value, options, colors, depth + 1, seen, entry.path)
    }
    if (entry.kind === "property") {
      return `${colors.cyan(entry.name)}: ${formatInlineValue(entry.value, options, colors, depth + 1, seen, entry.path)}`
    }
    const renderedKey = formatInlineValue(entry.key, options, colors, depth + 1, seen, entry.path.concat("<key>"))
    const renderedValue = formatInlineValue(entry.value, options, colors, depth + 1, seen, entry.path.concat(String(entry.key)))
    return `${renderedKey} ${colors.dim("=>")} ${renderedValue}`
  })
  if (entries.length > limit) items.push(colors.dim(`... ${entries.length - limit} more`))
  const result = `${colors.dim(opening)}${items.join(colors.dim(", "))}${colors.dim(closing)}`
  seen.delete(value)
  return result
}

export function createPrettyTerminalLoggerBackend(options: PrettyTerminalLoggerOptions = {}): ContextLoggerBackend {
  const renderOptions = resolveRenderOptions(options)
  const colors = createColorPalette(shouldUseColors(options.useColors))
  const outputConsole = options.console ?? console
  return {
    log(_context, entry) {
      const parts: string[] = []
      if (renderOptions.includeTimestamp) parts.push(colors.dim(formatTimestamp(entry.timestamp)))
      const levelLabel = entry.level.toUpperCase().padEnd(LEVEL_LABEL_WIDTH)
      parts.push(colors.level(entry.level, levelLabel))
      if (entry.scope !== undefined) parts.push(colors.cyan(entry.scope))
      parts.push(entry.level === "error" ? colors.bold(entry.message) : entry.message)
      if (renderOptions.includeContextPath && isContext(entry.context)) {
        const path = entry.context.getPath()
        if (path.length > 0) parts.push(colors.dim(`ctx=${path.join("/")}`))
      }
      const seen = new WeakSet<object>()
      if (!isContext(entry.context) && entry.context !== undefined && entry.context !== null &&
        typeof entry.context === "object" && Object.keys(entry.context).length > 0) {
        parts.push(`${colors.dim("context=")}${formatInlineValue(entry.context, renderOptions, colors, 0, seen, ["context"])}`)
      }
      if (entry.metadata !== undefined && Object.keys(entry.metadata).length > 0) {
        parts.push(`${colors.dim("meta=")}${formatInlineValue(entry.metadata, renderOptions, colors, 0, seen, ["metadata"])}`)
      }
      const outputLines = [parts.join(" ")]
      if (entry.error !== undefined) {
        const value = isErrorLike(entry.error)
          ? formatErrorSummary(entry.error, renderOptions, colors, 0, seen, ["error"])
          : formatInlineValue(entry.error, renderOptions, colors, 0, seen, ["error"])
        outputLines[0] = `${outputLines[0]} ${colors.dim("error=")}${value}`
        if (isErrorLike(entry.error) && typeof entry.error.stack === "string") {
          for (const line of entry.error.stack.split("\n").slice(1)) {
            const trimmed = line.trim()
            if (trimmed) outputLines.push(`${renderOptions.indent}${colors.dim(trimmed)}`)
          }
        }
      }
      const output = outputLines.join("\n")
      switch (entry.level) {
        case "debug":
        case "info": outputConsole.log(output); return
        case "warn": outputConsole.warn(output); return
        case "error": outputConsole.error(output); return
        default: throw new Error(`Unhandled log level: ${String(entry.level)}`)
      }
    },
  }
}

const defaultLoggerBackendImpl = createPrettyTerminalLoggerBackend()

/** Read-only view of the default backend, kept stable so swapping it cannot rewrite this module. */
const defaultLoggerBackend: ContextLoggerBackend = {
  log: (context, entry) => defaultLoggerBackendImpl.log(context, entry),
}

export const loggerKey: ContextKey<ContextLoggerBackend> = createKey(
  Symbol("loggerBackend"),
  defaultLoggerBackend,
)

export function getLoggerBackend(context: Context): ContextLoggerBackend {
  return context.get(loggerKey)
}

/**
 * A logger bound to a scope label. The label is diagnostic only — where a line is written is
 * decided by the context's backend, not by the logger.
 */
export function createLogger(scope?: string): ContextLogger {
  function log(context: Context, entry: Omit<ContextLogEntry, "timestamp">): void {
    const timestamp = new Date()
    getLoggerBackend(context).log(context, scope === undefined ? { ...entry, timestamp } : { ...entry, timestamp, scope })
  }
  return {
    debug: (context, message, metadata) => log(context, { level: "debug", message, context, metadata }),
    info: (context, message, metadata) => log(context, { level: "info", message, context, metadata }),
    warn: (context, message, metadata) => log(context, { level: "warn", message, context, metadata }),
    error: (context, message, error, metadata) => log(context, { level: "error", message, context, error, metadata }),
  }
}

/** Stamps every entry logged under `context` with the given attributes. */
export function withLogAttributes(
  context: Context,
  attributes: Readonly<Record<string, unknown>>,
): Context {
  const inheriting: ContextLoggerBackend = {
    log(innerContext, entry) {
      context.get(loggerKey).log(innerContext, {
        ...entry,
        metadata: { ...attributes, ...entry.metadata },
      })
    },
  }
  return context.with(loggerKey, inheriting)
}
