import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import {
  createLogger,
  createPrettyTerminalLoggerBackend,
  getLoggerBackend,
  loggerKey,
  withLogAttributes,
  type ContextLogEntry,
  type PrettyTerminalLoggerOptions,
} from "../../source/packages/context/logging.ts"

interface Line {
  readonly method: "log" | "warn" | "error"
  readonly text: string
}

/** Renders one entry through the pretty backend and returns the console lines it wrote. */
function render(entry: Omit<ContextLogEntry, "timestamp">, options: PrettyTerminalLoggerOptions = {}): Line[] {
  return renderWith(entry, { ...options, useColors: false })
}

/** As `render`, but leaves the color decision to the environment (NO_COLOR / FORCE_COLOR / TTY). */
function renderWithDetectedColors(entry: Omit<ContextLogEntry, "timestamp">): Line[] {
  return renderWith(entry, {})
}

function renderWith(entry: Omit<ContextLogEntry, "timestamp">, options: PrettyTerminalLoggerOptions): Line[] {
  const lines: Line[] = []
  const backend = createPrettyTerminalLoggerBackend({
    ...options,
    console: {
      log: text => lines.push({ method: "log", text }),
      warn: text => lines.push({ method: "warn", text }),
      error: text => lines.push({ method: "error", text }),
    },
  })
  backend.log(createContext(), { ...entry, timestamp: new Date("2026-09-25T10:11:12.345Z") })
  return lines
}

const timestamped = (text: string): string => `10:11:12.345 ${text}`

test("the pretty backend writes one line per entry and routes by level", () => {
  assert.deepEqual(render({ level: "info", message: "started" }), [
    { method: "log", text: timestamped("INFO  started") },
  ])
  assert.deepEqual(render({ level: "debug", message: "noise" }), [
    { method: "log", text: timestamped("DEBUG noise") },
  ])
  assert.deepEqual(render({ level: "warn", message: "slow" }), [
    { method: "warn", text: timestamped("WARN  slow") },
  ])
})

test("the timestamp can be dropped and the level label stays aligned", () => {
  const lines = render({ level: "warn", message: "slow" }, { includeTimestamp: false })
  assert.equal(lines[0]?.text, "WARN  slow")
})

test("the scope, the context path, metadata and the context value each render in place", () => {
  const entryContext = createContext().withName("run").withName("turn")
  const lines = render({
    level: "info",
    message: "sent",
    scope: "host.transcript",
    context: entryContext,
    metadata: { attempt: 2, channel: "rooms" },
  })
  assert.equal(
    lines[0]?.text,
    timestamped('INFO  host.transcript sent ctx=run/turn meta={attempt: 2, channel: "rooms"}'),
  )

  const asData = render({ level: "info", message: "payload", context: { id: "a1" } })
  assert.equal(asData[0]?.text, timestamped(`INFO  payload context={id: "a1"}`))

  const unnamed = render({ level: "info", message: "bare", context: createContext() })
  assert.equal(unnamed[0]?.text, timestamped("INFO  bare"))
})

test("an error renders inline and its stack follows on indented lines", () => {
  const error = new Error("gateway refused the command")
  error.stack = "Error: gateway refused the command\n    at handle (/work/gateway.ts:12:3)\n    at run (/work/run.ts:4:1)"
  const lines = render({ level: "error", message: "command failed", error })

  assert.equal(lines.length, 1, "one entry is one console call, stack included")
  assert.equal(lines[0]?.method, "error")
  assert.deepEqual(lines[0]?.text.split("\n"), [
    timestamped("ERROR command failed error=Error: gateway refused the command"),
    "  at handle (/work/gateway.ts:12:3)",
    "  at run (/work/run.ts:4:1)",
  ])
})

test("an error cause chain is rendered as a nested summary", () => {
  const cause = new Error("socket closed")
  const error = new Error("request failed", { cause })
  error.stack = "Error: request failed"
  const lines = render({ level: "error", message: "upload failed", error })
  assert.equal(
    lines[0]?.text,
    timestamped("ERROR upload failed error=Error: request failed cause=Error: socket closed"),
  )
})

test("values render by type and are cut off at the configured limits", () => {
  const many = Array.from({ length: 5 }, (_, index) => index)
  assert.equal(
    render({ level: "info", message: "m", metadata: { list: many, date: new Date("2026-01-02T03:04:05.000Z") } }, {
      maxArrayLength: 2,
    })[0]?.text,
    timestamped("INFO  m meta={list: [0, 1, ... 3 more], date: 2026-01-02T03:04:05.000Z}"),
  )
  assert.equal(
    render({ level: "info", message: "m", metadata: { long: "abcdefghij" } }, { maxStringLength: 4 })[0]?.text,
    timestamped('INFO  m meta={long: "abcd..."}'),
  )
  assert.equal(
    render({ level: "info", message: "m", metadata: { deep: { a: { b: 1 } } } }, { maxDepth: 1 })[0]?.text,
    timestamped("INFO  m meta={deep: [Object]}"),
  )
  assert.equal(
    render({ level: "info", message: "m", metadata: { big: 10n, re: /ab+c/g, set: new Set([1]) } })[0]?.text,
    timestamped('INFO  m meta={big: 10n, re: /ab+c/g, set: [1]}'),
  )
})

test("cycles are reported instead of expanded", () => {
  const node: Record<string, unknown> = {}
  node.self = node
  assert.equal(
    render({ level: "info", message: "m", metadata: node })[0]?.text,
    timestamped("INFO  m meta={self: [Circular]}"),
  )
})

test("an object carrying a name, message, stack or cause is summarized as error-like", () => {
  assert.equal(
    render({ level: "info", message: "m", metadata: { failure: { name: "gateway", message: "refused" } } })[0]?.text,
    timestamped("INFO  m meta={failure: gateway: refused}"),
  )
  assert.equal(
    render({ level: "info", message: "m", metadata: { plain: { label: "gateway" } } })[0]?.text,
    timestamped('INFO  m meta={plain: {label: "gateway"}}'),
  )
})

test("an inline serializer can replace a value, and cannot break logging", () => {
  const redacting: PrettyTerminalLoggerOptions = {
    inlineSerializer: (value, { path }) => {
      if (path.at(-1) === "token") return { kind: "summary", summary: "redacted" }
      return value
    },
  }
  assert.equal(
    render({ level: "info", message: "m", metadata: { token: "s3cret", keep: true } }, redacting)[0]?.text,
    timestamped("INFO  m meta={token: <redacted>, keep: true}"),
  )

  const throwing: PrettyTerminalLoggerOptions = {
    inlineSerializer: () => {
      throw new Error("serializer exploded")
    },
  }
  assert.equal(
    render({ level: "info", message: "m", metadata: { value: 1 } }, throwing)[0]?.text,
    timestamped("INFO  m meta={value: 1}"),
  )
})

test("colors follow NO_COLOR, a dumb terminal, FORCE_COLOR, and can be forced off", () => {
  const previous = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, TERM: process.env.TERM }
  const detected = (message: string): string =>
    renderWithDetectedColors({ level: "info", message })[0]?.text ?? ""
  try {
    process.env.NO_COLOR = "1"
    process.env.FORCE_COLOR = "1"
    process.env.TERM = "xterm-256color"
    assert.equal(detected("plain"), timestamped("INFO  plain"), "NO_COLOR beats FORCE_COLOR")

    delete process.env.NO_COLOR
    process.env.TERM = "dumb"
    assert.equal(detected("dumb"), timestamped("INFO  dumb"), "a dumb terminal beats FORCE_COLOR")

    process.env.TERM = "xterm-256color"
    assert.match(detected("colored"), /\u001b\[34mINFO \u001b\[0m/, "the level label is colored")

    process.env.FORCE_COLOR = "0"
    assert.equal(detected("off"), timestamped("INFO  off"), "FORCE_COLOR=0 switches them off")

    delete process.env.FORCE_COLOR
    process.env.NO_COLOR = "1"
    assert.equal(detected("plain"), timestamped("INFO  plain"))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("the backend comes from the context, so a subtree can be redirected", () => {
  const collected: ContextLogEntry[] = []
  const root = createContext()
  const redirected = root.with(loggerKey, { log: (_context, entry) => collected.push(entry) })
  const log = createLogger("host.runner")

  log.info(redirected, "kept", { step: 1 })
  log.warn(redirected.withName("nested"), "also kept")
  log.error(redirected, "failed", new Error("boom"))

  assert.deepEqual(collected.map(entry => entry.level), ["info", "warn", "error"])
  assert.equal(collected[0]?.message, "kept")
  assert.equal(collected[0]?.scope, "host.runner")
  assert.ok(collected[0]?.timestamp instanceof Date)
  assert.deepEqual(collected[0]?.metadata, { step: 1 })
  assert.equal((collected[2]?.error as Error).message, "boom")
})

test("a logger without a scope stays unscoped", () => {
  const collected: ContextLogEntry[] = []
  const ctx = createContext().with(loggerKey, { log: (_context, entry) => collected.push(entry) })
  createLogger().info(ctx, "bare")
  assert.equal(collected[0]?.scope, undefined)
})

test("withLogAttributes stamps the subtree, and an entry's own metadata wins", () => {
  const collected: ContextLogEntry[] = []
  const base = createContext().with(loggerKey, { log: (_context, entry) => collected.push(entry) })
  const scoped = withLogAttributes(base, { agentId: "a1", attempt: 1 })
  const log = createLogger("host.memory")

  log.info(scoped, "first")
  log.info(scoped.withName("deeper"), "second", { attempt: 2 })
  log.info(base, "outside")

  assert.deepEqual(collected[0]?.metadata, { agentId: "a1", attempt: 1 })
  assert.deepEqual(collected[1]?.metadata, { agentId: "a1", attempt: 2 }, "call-site metadata overrides")
  assert.equal(collected[2]?.metadata, undefined, "the unscoped context is untouched")
})

test("stacked attribute scopes merge outermost first", () => {
  const collected: ContextLogEntry[] = []
  const base = createContext().with(loggerKey, { log: (_context, entry) => collected.push(entry) })
  const inner = withLogAttributes(withLogAttributes(base, { runId: "r1", attempt: 1 }), { attempt: 2 })

  createLogger().info(inner, "merged")
  assert.deepEqual(collected[0]?.metadata, { runId: "r1", attempt: 2 })
})

test("the default backend is what an unstyled context logs to", () => {
  const ctx = createContext()
  assert.equal(getLoggerBackend(ctx).log.name.length > 0, true, "a backend is always available")
})

test("an unknown level is rejected rather than silently dropped", () => {
  const backend = createPrettyTerminalLoggerBackend({ useColors: false, console: { log() {}, warn() {}, error() {} } })
  assert.throws(
    () => backend.log(createContext(), {
      level: "trace" as ContextLogEntry["level"],
      message: "nope",
      timestamp: new Date(),
    }),
    /Unhandled log level: trace/,
  )
})

test("the entry context is passed through to the backend unchanged", () => {
  const collected: { context: Context; entry: ContextLogEntry }[] = []
  const ctx = createContext().with(loggerKey, {
    log: (context, entry) => collected.push({ context, entry }),
  })
  const named = ctx.withName("run")
  createLogger("host.box").info(named, "ok")
  assert.equal(collected[0]?.context, named)
})
