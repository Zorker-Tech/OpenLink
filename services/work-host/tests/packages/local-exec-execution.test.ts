import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readMcpDiskCatalogToolNamesForProjectDir } from "../../source/packages/local-exec/mcp-disk-catalog-read.ts"
import { API_WIDTH, buildResolutionConfig, parseDisplayNum, parseXrandrOutput } from "../../source/packages/local-exec/computer-use/display.ts"
import { shellBlockReasonMessage } from "../../source/packages/local-exec/utils/edit-block-handler.ts"
import { shellCommandBlockResultForInterop } from "../../source/adapters/interop/agent/shell-block-result-adapter.ts"
import { parseGrepContentOutput, parseGrepCountOutput, parseGrepFilesOutput, splitGrepLines } from "../../source/packages/local-exec/grep-output.ts"
import { BaseShellCoreExecutor, type ShellCoreArgs } from "../../source/packages/local-exec/shell-core.ts"
import { McpFileSystemWriter } from "../../source/packages/local-exec/mcp-file-system-writer.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { SHELL_OUTPUT_SUPPRESSED_NOTICE } from "../../source/packages/shell-exec/output-suppression.ts"

// ---------------------------------------------------------------------------------------------
// The MCP catalog on disk
// ---------------------------------------------------------------------------------------------

test("a project's MCP catalog is read back from the files it holds", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-catalog-"))
  try {
    // Nothing written yet is an empty catalog, not a failure.
    assert.deepEqual(await readMcpDiskCatalogToolNamesForProjectDir(projectDir, "my server"), { toolNames: [], toolsDirExists: false })

    const toolsDir = path.join(projectDir, "mcps", "my_server", "tools")
    fs.mkdirSync(toolsDir, { recursive: true })
    assert.deepEqual(await readMcpDiskCatalogToolNamesForProjectDir(projectDir, "my server"), { toolNames: [], toolsDirExists: true })
    fs.writeFileSync(path.join(toolsDir, "b.json"), JSON.stringify({ name: "second" }))
    fs.writeFileSync(path.join(toolsDir, "a.json"), JSON.stringify({ name: "first" }))
    fs.writeFileSync(path.join(toolsDir, "c.json"), JSON.stringify({ name: "first" }))
    fs.writeFileSync(path.join(toolsDir, "fallback.json"), JSON.stringify({ toolName: "third" }))
    fs.mkdirSync(path.join(toolsDir, "folder.json"))
    // Only the definition files count, however much a file that is not one looks like JSON.
    fs.writeFileSync(path.join(toolsDir, "notes.txt"), JSON.stringify({ name: "not-a-definition" }))
    fs.writeFileSync(path.join(toolsDir, "ignored.JSON"), JSON.stringify({ name: "wrong-case-extension" }))
    fs.writeFileSync(path.join(toolsDir, "broken.json"), "{ not json")

    const catalog = await readMcpDiskCatalogToolNamesForProjectDir(projectDir, "my server")
    assert.equal(catalog.toolsDirExists, true)
    // The names are sorted, the entries that are not definitions are left out, and the server's name is the
    // sanitized one it is filed under.
    assert.deepEqual(catalog.toolNames, ["first", "second", "third"])
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test("a catalog path that exists as a file reports the directory error", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-catalog-file-path-"))
  try {
    const serverDir = path.join(projectDir, "mcps", "my_server")
    fs.mkdirSync(serverDir, { recursive: true })
    fs.writeFileSync(path.join(serverDir, "tools"), "not a directory")

    await assert.rejects(
      readMcpDiskCatalogToolNamesForProjectDir(projectDir, "my server"),
      (error: NodeJS.ErrnoException) => error.code === "ENOTDIR",
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// The display
// ---------------------------------------------------------------------------------------------

test("the display's number is read out of its X11 spelling", () => {
  assert.equal(parseDisplayNum(":0"), 0)
  assert.equal(parseDisplayNum(":1.0"), 1)
  assert.equal(parseDisplayNum("host.example:12"), 12)
  assert.throws(() => parseDisplayNum("host.example"), /missing ':'/)
  assert.throws(() => parseDisplayNum(":notanumber"), /Invalid X11 display number/)
})

test("the active mode is the one the display reports", () => {
  const output = [
    "Screen 0: minimum 1 x 1, current 2560 x 1440, maximum 8192 x 8192",
    "HDMI-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 600mm x 340mm",
    "   1920x1080     60.00 +",
    "   2560x1440     59.95*",
  ].join("\n")
  assert.deepEqual(parseXrandrOutput(output), { width: 2560, height: 1440, refreshRate: 60 })

  // A mode that is not marked is read from the summary line, and a rate that was not reported is the default.
  const summaryOnly = "Screen 0: minimum 1 x 1, current 1680 x 1050, maximum 8192 x 8192"
  assert.deepEqual(parseXrandrOutput(summaryOnly), { width: 1680, height: 1050, refreshRate: 60 })
  assert.throws(() => parseXrandrOutput("nothing useful here"), /Could not detect display resolution/)
})

test("display parsing keeps a valid active refresh rate and uses the default for unusable values", () => {
  assert.deepEqual(parseXrandrOutput("  1920x1080  59.94*+"), { width: 1920, height: 1080, refreshRate: 60 })
  assert.deepEqual(parseXrandrOutput("  1920x1080  501.00*+"), { width: 1920, height: 1080, refreshRate: 60 })
  assert.equal(parseDisplayNum("display.example:3:12.0"), 12)
})

test("the API keeps the display's shape at a fixed width", () => {
  const resolution = buildResolutionConfig(2_560, 1_440)
  assert.equal(resolution.display.width, 2_560)
  assert.equal(resolution.api.width, API_WIDTH)
  assert.equal(resolution.api.height, Math.round(API_WIDTH / (2_560 / 1_440)))
})

// ---------------------------------------------------------------------------------------------
// What a blocked command reports
// ---------------------------------------------------------------------------------------------

test("a blocked command reports the reason it was blocked", () => {
  assert.equal(shellBlockReasonMessage({ type: "userDeclined", detail: "not now" }), "not now")
  assert.equal(shellBlockReasonMessage({ type: "unsafeWorkingDirectory", message: "unsafe" }), "unsafe")
  assert.match(shellBlockReasonMessage({ type: "administratorCommandRule", pattern: "npm:install *" }), /denylist rule: npm:install \*/)
  assert.equal(shellBlockReasonMessage({ type: "approvalRequired" }), "Command is not allowed")
  assert.equal(shellBlockReasonMessage({ type: "ignorePolicy" }), "Command is not allowed")
  assert.equal(shellBlockReasonMessage({ type: "managedInstructionFiles" }), "Command is not allowed")
})

test("a command blocked by a read-only session is a permission denial rather than a rejection", () => {
  const denied = shellCommandBlockResultForInterop("rm -rf /", "/repo", { type: "permissionConfiguration", isReadOnly: true })
  assert.equal(denied.case, "permissionDenied")
  assert.equal(denied.value?.isReadonly, true)
  assert.equal(denied.value?.command, "rm -rf /")

  // The same block without the read-only marker is an ordinary rejection.
  const rejected = shellCommandBlockResultForInterop("rm -rf /", "/repo", { type: "permissionConfiguration" })
  assert.equal(rejected.case, "rejected")
  assert.equal(rejected.value?.reason, "Command is not allowed")
})

// ---------------------------------------------------------------------------------------------
// What ripgrep printed
// ---------------------------------------------------------------------------------------------

test("a search that listed files reports what it found and what was cut", () => {
  assert.deepEqual(splitGrepLines("a\r\nb\rc"), ["a", "b", "c"])

  const listed = parseGrepFilesOutput("a.ts\nb.ts\nc.ts\n", 2, 100)
  assert.deepEqual(listed.files, ["a.ts", "b.ts"])
  assert.equal(listed.totalFiles, 3)
  assert.equal(listed.clientTruncated, true)
  assert.equal(listed.ripgrepTruncated, false)

  // The hard cutoff is ripgrep's own limit, and it is reported apart from the client's.
  const cutOff = parseGrepFilesOutput("a.ts\nb.ts", 10, 2)
  assert.equal(cutOff.clientTruncated, false)
  assert.equal(cutOff.ripgrepTruncated, true)
  assert.deepEqual(parseGrepFilesOutput("", 10, 10).files, [])
})

test("a search that counted matches adds the counts up", () => {
  const counts = parseGrepCountOutput("a.ts:3\nb.ts:4\nnonsense\n", 10, 100)
  assert.deepEqual(counts.counts, [{ file: "a.ts", count: 3 }, { file: "b.ts", count: 4 }])
  assert.equal(counts.totalFiles, 2)
  assert.equal(counts.totalMatches, 7)
})

test("a search that printed matches groups them by file and tells context from matches", () => {
  const stdout = ["a.ts\0" + "12:the matching line", "a.ts\0" + "13-a context line", "b.ts\0" + "7:another match", "--", ""].join("\n")
  const parsed = parseGrepContentOutput(stdout, 100, 100, createContext())

  assert.equal(parsed.totalFiles, 2)
  assert.equal(parsed.totalMatchedLines, 2)
  const a = parsed.byFile.get("a.ts")
  assert.deepEqual(a?.matches.map(match => match.lineNumber), [12, 13])
  assert.equal(a?.matches[1]?.isContextLine, true)
  assert.equal(parsed.byFile.get("b.ts")?.matches[0]?.content, "another match")
})

// ---------------------------------------------------------------------------------------------
// Running a command with the platform's environment
// ---------------------------------------------------------------------------------------------

function shellCoreEvents(events: readonly Record<string, unknown>[]) {
  return {
    async *execute() {
      for (const event of events) yield event
    },
    async getCwd() {
      return "/repo"
    },
  }
}

function shellCoreProbe(events: readonly Record<string, unknown>[], cwd = "/repo", failure?: Error) {
  const calls: Array<{ command: string; options: Record<string, unknown> }> = []
  const executor = {
    async getCwd() { return cwd },
    async *execute(_ctx: unknown, command: string, options: Record<string, unknown> = {}) {
      calls.push({ command, options })
      for (const event of events) yield event
      if (failure !== undefined) throw failure
    },
  }
  return { executor, calls }
}

async function collectShellCore(core: BaseShellCoreExecutor, args: ShellCoreArgs) {
  const events: Array<Record<string, unknown>> = []
  for await (const event of core.execute(createContext(), args)) events.push(event as Record<string, unknown>)
  return events
}

test("a command runs with the session in its environment", async () => {
  let seen: { env?: NodeJS.ProcessEnv; workingDirectory?: string } = {}
  const executor = {
    async *execute(_ctx: unknown, _command: string, options: { env?: NodeJS.ProcessEnv; workingDirectory?: string }) {
      seen = options
      yield { type: "stdout", data: Buffer.from("hi") }
      yield { type: "exit", code: 0, aborted: false }
    },
    async getCwd() {
      return "/repo"
    },
  }
  const core = new BaseShellCoreExecutor(executor as never, "/workspace", "/project")
  const events: Array<Record<string, unknown>> = []
  for await (const event of core.execute(createContext(), { command: "echo hi", conversationId: "conversation-1" })) {
    events.push(event as Record<string, unknown>)
  }

  assert.equal(seen.env?.SLATE_AGENT, "1")
  assert.equal(seen.env?.SLATE_CONVERSATION_ID, "conversation-1")
  assert.equal(seen.env?.SLATE_AGENT_TRANSCRIPTS?.startsWith("/project"), true)
  // The request-scoped variables are put back after the command rather than left to the next one.
  assert.match(String(seen.env?.__SLATE_SANDBOX_ENV_RESTORE), /unset SLATE_CONVERSATION_ID/)
  // A caller that named no directory runs where the executor already is.
  assert.equal(seen.workingDirectory, "/repo")
  assert.equal(events.some(event => event.type === "stdout" && event.data === "hi"), true)
  assert.equal(events.at(-1)?.type, "exit")
  assert.equal(typeof events.at(-1)?.localExecutionTimeMs, "number")
})

test("the agent store's own folders are added to whatever may be written", async () => {
  let policy: unknown
  const executor = {
    async *execute(_ctx: unknown, _command: string, options: { sandboxPolicy?: unknown }) {
      policy = options.sandboxPolicy
      yield { type: "exit", code: 0, aborted: false }
    },
    async getCwd() {
      return "/repo"
    },
  }
  const core = new BaseShellCoreExecutor(executor as never)
  const env = { SLATE_AGENT_STORE_FILES_DIR: "/store/files", SLATE_AGENT_STORE_SHARED_PATHS: JSON.stringify({ a: { path: "/store/shared", readOnly: true } }) }
  for await (const _event of core.execute(createContext(), { command: "ls", sandboxPolicy: { perRepo: { type: "workspace_readwrite" } } })) {
    void _event
  }
  // With nothing in the environment to add, the caller's own policy is handed over as it was.
  assert.deepEqual(policy, { perRepo: { type: "workspace_readwrite" } })

  const withEnv = new BaseShellCoreExecutor(executor as never, undefined, undefined, undefined, () => env)
  const events: Array<Record<string, unknown>> = []
  for await (const event of withEnv.execute(createContext(), { command: "ls", sandboxPolicy: { perRepo: { type: "workspace_readwrite" } } })) {
    events.push(event as Record<string, unknown>)
  }
  assert.deepEqual(events[0], { type: "start", sandboxed: true })
  const added = (policy as { perUser?: { additionalReadwritePaths?: string[]; additionalReadonlyPaths?: string[] } }).perUser
  assert.deepEqual(added?.additionalReadwritePaths, ["/store/files"])
  assert.deepEqual(added?.additionalReadonlyPaths, ["/store/shared"])
})

test("output past the buffer size is cut off and said so", async () => {
  const executor = {
    async *execute() {
      yield { type: "stdout", data: Buffer.alloc(1_048_577, "x") }
      yield { type: "stdout", data: Buffer.from("more") }
      yield { type: "stderr", data: Buffer.alloc(1_048_577, "y") }
      yield { type: "exit", code: 0, aborted: false }
    },
    async getCwd() {
      return "/repo"
    },
  }
  const core = new BaseShellCoreExecutor(executor as never)
  const events: Array<Record<string, unknown>> = []
  for await (const event of core.execute(createContext(), { command: "noisy" })) events.push(event as Record<string, unknown>)

  assert.equal(events.some(event => event.type === "stdout_trimmed"), true)
  assert.equal(events.some(event => event.type === "stderr_trimmed"), true)
  // The first chunk was already over the buffer, so nothing of it is carried and the later chunk is not either.
  assert.equal(events.some(event => event.type === "stdout" && event.data === "more"), false)
})

test("output past the file threshold is written to a file in the project instead", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-core-"))
  try {
    const executor = {
      async *execute() {
        yield { type: "stdout", data: Buffer.from("a\nb\nc\n") }
        yield { type: "exit", code: 0, aborted: false }
      },
      async getCwd() {
        return "/repo"
      },
    }
    const core = new BaseShellCoreExecutor(executor as never, "/workspace", projectDir)
    const events: Array<Record<string, unknown>> = []
    for await (const event of core.execute(createContext(), { command: "noisy", fileOutputThresholdBytes: 1 })) {
      events.push(event as Record<string, unknown>)
    }

    const exit = events.at(-1)
    assert.equal(exit?.type, "exit")
    const location = exit?.outputLocation as { filePath?: string; sizeBytes?: bigint; lineCount?: bigint } | undefined
    assert.equal(location?.filePath?.startsWith(projectDir), true)
    assert.equal(fs.readFileSync(location!.filePath!, "utf8"), "a\nb\nc\n")
    assert.equal(location?.sizeBytes, 6n)
    assert.equal(location?.lineCount, 3n)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test("a suppressed output is reported once", async () => {
  const executor = {
    async *execute() {
      yield { type: "suppressed_output" }
      yield { type: "suppressed_output" }
      yield { type: "exit", code: 0, aborted: false }
    },
    async getCwd() {
      return "/repo"
    },
  }
  const core = new BaseShellCoreExecutor(executor as never)
  const events: Array<Record<string, unknown>> = []
  for await (const event of core.execute(createContext(), { command: "quiet" })) events.push(event as Record<string, unknown>)

  const notices = events.filter(event => event.type === "stdout" && event.data === SHELL_OUTPUT_SUPPRESSED_NOTICE)
  assert.equal(notices.length, 1)
})

test("sandbox start is yielded before execution and the core forwards command options and terminal events", async () => {
  const stdin = { marker: "stdin" }
  const deny = { path: "/workspace/blocked" }
  const denies = [deny]
  const limiter = { maximumBufferedBytes: 48 }
  const signal = new AbortController().signal
  const fixture = shellCoreProbe([
    { type: "stdin_ready", stdin, pid: 42 },
    { type: "sandbox_denies", events: denies },
    { type: "exit", code: null, aborted: true },
  ])
  const core = new BaseShellCoreExecutor(
    fixture.executor as never,
    "/workspace/project",
    undefined,
    { bufferOutputEvents: true, outputLimiterOptions: limiter },
  )
  const iterator = core.execute(createContext(), {
    command: "build",
    workingDirectory: "../checkout",
    signal,
    sandboxPolicy: {},
    pipeStdin: true,
  })[Symbol.asyncIterator]()

  const start = await iterator.next()
  assert.deepEqual(start.value, { type: "start", sandboxed: false })
  assert.equal(fixture.calls.length, 0, "the executor is not started until the consumer asks for the next event")

  const ready = await iterator.next()
  assert.equal(ready.value?.type, "stdin_ready")
  assert.equal((ready.value as { stdin?: unknown }).stdin, stdin)
  assert.equal((ready.value as { pid?: number }).pid, 42)
  const denyEvent = await iterator.next()
  assert.equal(denyEvent.value?.type, "sandbox_denies")
  assert.equal((denyEvent.value as { events?: unknown }).events, denies)
  const exit = await iterator.next()
  assert.deepEqual(exit.value && { type: exit.value.type, code: (exit.value as { code?: unknown }).code, aborted: (exit.value as { aborted?: unknown }).aborted }, {
    type: "exit", code: null, aborted: true,
  })

  const call = fixture.calls[0]!
  assert.equal(call.command, "build")
  assert.equal(call.options.workingDirectory, "/workspace/checkout")
  assert.equal(call.options.signal, signal)
  assert.equal(call.options.pipeStdin, true)
  assert.equal(call.options.bufferOutputEvents, true)
  assert.equal(call.options.outputLimiterOptions, limiter)
  assert.equal((await iterator.next()).done, true)
})

test("the environment restore command combines earlier hooks and safely quotes request-scoped values", async () => {
  const oldRestore = process.env.__SLATE_SANDBOX_ENV_RESTORE
  process.env.__SLATE_SANDBOX_ENV_RESTORE = "global restore"
  try {
    const fixture = shellCoreProbe([{ type: "exit", code: 0, aborted: false }])
    const core = new BaseShellCoreExecutor(fixture.executor as never, undefined, "/project", undefined, () => ({
      SLATE_AGENT: "caller-agent-marker",
      SLATE_CONVERSATION_ID: "request's id",
      SLATE_AGENT_STORE_FILES_DIR: "/store/files",
      __SLATE_SANDBOX_ENV_RESTORE: "provided restore",
    }))
    await collectShellCore(core, {
      command: "whoami",
      conversationId: "ignored-by-provider",
      askpassConfig: { helperPath: "/helper", socketPath: "/socket", secret: "secret" },
    })

    const env = fixture.calls[0]!.options.env as NodeJS.ProcessEnv
    assert.equal(env.SLATE_AGENT, "caller-agent-marker", "extra environment values are applied after built-ins")
    assert.equal(env.SLATE_CONVERSATION_ID, "request's id")
    const restore = String(env.__SLATE_SANDBOX_ENV_RESTORE)
    assert.ok(restore.startsWith("global restore; provided restore; builtin unset SLATE_CONVERSATION_ID SLATE_AGENT_STORE_FILES_DIR SLATE_AGENT_STORE_SHARED_PATHS"))
    assert.ok(restore.includes("builtin export SLATE_CONVERSATION_ID='request'\\''s id'"))
    assert.ok(restore.includes("builtin export SLATE_AGENT_STORE_FILES_DIR='/store/files'"))
    assert.equal(env.SUDO_ASKPASS, process.platform === "win32" ? undefined : "/helper")
    assert.equal(env.SLATE_ASKPASS_SOCKET, process.platform === "win32" ? undefined : "/socket")
  } finally {
    if (oldRestore === undefined) delete process.env.__SLATE_SANDBOX_ENV_RESTORE
    else process.env.__SLATE_SANDBOX_ENV_RESTORE = oldRestore
  }
})

test("agent-store paths are deduplicated and follow the effective workspace mode", async () => {
  const entries = [
    { path: "/store/files", readOnly: false },
    { path: "/store/shared", readOnly: true },
    { path: "/store/ignored", readOnly: "yes" },
  ]
  const fixture = shellCoreProbe([{ type: "exit", code: 0, aborted: false }])
  const core = new BaseShellCoreExecutor(fixture.executor as never, undefined, undefined, undefined, () => ({
    SLATE_AGENT_STORE_FILES_DIR: "/store/files",
    SLATE_AGENT_STORE_SHARED_PATHS: JSON.stringify(entries),
  }))
  const original = {
    perRepo: { type: "workspace_readonly" as const, additionalReadPaths: ["/repo/read"] },
    perUser: { type: "workspace_readwrite" as const, additionalReadwritePaths: ["/already/write"], additionalReadonlyPaths: ["/already/read"] },
  }
  await collectShellCore(core, { command: "list", sandboxPolicy: original })

  const policy = fixture.calls[0]!.options.sandboxPolicy as typeof original
  assert.deepEqual(policy, {
    perRepo: original.perRepo,
    perUser: {
      type: "workspace_readonly",
      additionalReadwritePaths: ["/already/write"],
      additionalReadonlyPaths: ["/already/read", "/store/files", "/store/shared"],
    },
  })
  assert.deepEqual(original.perUser.additionalReadonlyPaths, ["/already/read"], "the caller policy is not mutated")
})

test("an invalid shared-path payload leaves a non-workspace policy untouched", async () => {
  const fixture = shellCoreProbe([{ type: "exit", code: 0, aborted: false }])
  const core = new BaseShellCoreExecutor(fixture.executor as never, undefined, undefined, undefined, () => ({
    SLATE_AGENT_STORE_FILES_DIR: "/store/files",
    SLATE_AGENT_STORE_SHARED_PATHS: "{broken",
  }))
  const policy = { perRepo: { type: "insecure_none" as const } }
  await collectShellCore(core, { command: "list", sandboxPolicy: policy })
  assert.equal(fixture.calls[0]!.options.sandboxPolicy, policy)
})

test("stream buffers accept the exact limit once, then trim each output channel independently", async () => {
  const fixture = shellCoreProbe([
    { type: "stdout", data: Buffer.alloc(1_048_576, "x") },
    { type: "stdout", data: Buffer.from("too much") },
    { type: "stderr", data: Buffer.from("error") },
    { type: "stderr", data: Buffer.alloc(1_048_572, "y") },
    { type: "stderr", data: Buffer.from("after trim") },
    { type: "exit", code: 0, aborted: false },
  ])
  const core = new BaseShellCoreExecutor(fixture.executor as never)
  const events = await collectShellCore(core, { command: "noisy" })

  assert.equal((events.find((event) => event.type === "stdout")?.data as string).length, 1_048_576)
  assert.equal(events.filter((event) => event.type === "stdout_trimmed").length, 1)
  assert.equal(events.filter((event) => event.type === "stderr_trimmed").length, 1)
  assert.equal(events.some((event) => event.type === "stdout" && event.data === "too much"), false)
  assert.equal(events.some((event) => event.type === "stderr" && event.data === "error"), true)
  assert.equal(events.some((event) => event.type === "stderr" && event.data === "after trim"), false)
})

test("file output combines both streams in arrival order and opens only after crossing its threshold", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-core-ordered-output-"))
  try {
    const fixture = shellCoreProbe([
      { type: "stdout", data: Buffer.from("ab") },
      { type: "stderr", data: Buffer.from("c\n") },
      { type: "stdout", data: Buffer.from("d") },
      { type: "exit", code: 0, aborted: false },
    ])
    const core = new BaseShellCoreExecutor(fixture.executor as never, undefined, projectDir)
    const events = await collectShellCore(core, { command: "build", fileOutputThresholdBytes: 3 })
    const output = events.at(-1)?.outputLocation as { filePath: string; sizeBytes: bigint; lineCount: bigint } | undefined

    assert.ok(output)
    assert.equal(fs.readFileSync(output.filePath, "utf8"), "abc\nd")
    assert.equal(output.sizeBytes, 5n)
    assert.equal(output.lineCount, 1n)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test("output that never crosses the threshold and output without a project stay in memory", async () => {
  const fixture = shellCoreProbe([
    { type: "stdout", data: Buffer.from("abc") },
    { type: "exit", code: 0, aborted: false },
  ])
  const core = new BaseShellCoreExecutor(fixture.executor as never, undefined, "/project")
  const events = await collectShellCore(core, { command: "short", fileOutputThresholdBytes: 3 })
  assert.equal(events.at(-1)?.outputLocation, undefined)
  assert.equal(events.some((event) => event.type === "stdout" && event.data === "abc"), true)

  const withoutProject = new BaseShellCoreExecutor(fixture.executor as never)
  const noProjectEvents = await collectShellCore(withoutProject, { command: "short", fileOutputThresholdBytes: 1 })
  assert.equal(noProjectEvents.at(-1)?.outputLocation, undefined)
})

test("the executor error reaches the iterator and does not become a synthetic exit", async () => {
  const failure = new Error("terminal disconnected")
  const fixture = shellCoreProbe([{ type: "stdout", data: Buffer.from("partial") }], "/repo", failure)
  const core = new BaseShellCoreExecutor(fixture.executor as never)
  const events: Array<Record<string, unknown>> = []
  await assert.rejects(async () => {
    for await (const event of core.execute(createContext(), { command: "run" })) events.push(event as Record<string, unknown>)
  }, failure)
  assert.deepEqual(events, [{ type: "stdout", data: "partial" }])
})

test("cwd access is forwarded and an unconfigured workspace has an explicit error", async () => {
  const fixture = shellCoreProbe([])
  const core = new BaseShellCoreExecutor(fixture.executor as never)
  assert.equal(await core.getCwd(), "/repo")
  assert.throws(() => core.getWorkspacePath(), { message: "Workspace path is not configured" })
  assert.equal(new BaseShellCoreExecutor(fixture.executor as never, "/workspace").getWorkspacePath(), "/workspace")
})

// ---------------------------------------------------------------------------------------------
// The MCP catalog as files
// ---------------------------------------------------------------------------------------------

test("the catalog is written for the servers the lease knows", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-writer-"))
  try {
    const tool = { name: "search", toolName: "search", clientKey: "my-server", providerIdentifier: "My Server", annotations: { title: "Search" } }
    const client = {
      serverName: "My Server",
      getState: async () => ({ kind: "ready" }),
      getTools: async () => [{ name: "search" }],
      listResources: async () => ({ resources: [] }),
      listPrompts: async () => [],
      getInstructions: async () => "use it wisely",
    }
    const lease = {
      onDidChange: () => ({ dispose: () => {} }),
      getTools: async () => [tool],
      getInstructions: async () => [],
      getClients: async () => ({ "my-server": client }),
    }
    const writer = new McpFileSystemWriter(lease as never, projectDir, { useDirectClientTools: true })
    const options = await writer.getMcpFileSystemOptions(createContext())

    assert.equal(options?.enabled, true)
    assert.equal(options?.workspaceProjectDir, projectDir)
    const descriptor = options?.mcpDescriptors[0]
    assert.equal(descriptor?.serverIdentifier, "my-server")
    assert.equal(descriptor?.tools[0]?.toolName, "search")
    // The tool's definition is a file the model can be pointed at, and it is there.
    assert.equal(fs.existsSync(descriptor?.tools[0]?.definitionPath ?? ""), true)
    // And the folder the descriptor names is the one that was written.
    assert.equal(descriptor?.folderPath?.startsWith(projectDir), true)
    writer.dispose()
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
