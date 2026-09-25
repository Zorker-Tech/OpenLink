import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readMcpDiskCatalogToolNamesForProjectDir } from "../../source/packages/local-exec/mcp-disk-catalog-read.ts"
import { API_WIDTH, buildResolutionConfig, parseDisplayNum, parseXrandrOutput } from "../../source/packages/local-exec/computer-use/display.ts"
import { shellBlockReasonMessage, shellCommandBlockResult } from "../../source/packages/local-exec/utils/edit-block-handler.ts"
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
    fs.writeFileSync(path.join(toolsDir, "b.json"), JSON.stringify({ name: "second" }))
    fs.writeFileSync(path.join(toolsDir, "a.json"), JSON.stringify({ name: "first" }))
    // Only the definition files count, however much a file that is not one looks like JSON.
    fs.writeFileSync(path.join(toolsDir, "notes.txt"), JSON.stringify({ name: "not-a-definition" }))
    fs.writeFileSync(path.join(toolsDir, "broken.json"), "{ not json")

    const catalog = await readMcpDiskCatalogToolNamesForProjectDir(projectDir, "my server")
    assert.equal(catalog.toolsDirExists, true)
    // The names are sorted, the entries that are not definitions are left out, and the server's name is the
    // sanitized one it is filed under.
    assert.deepEqual(catalog.toolNames, ["first", "second"])
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
  assert.equal(shellBlockReasonMessage({ type: "userRejected", reason: "not now" }), "not now")
  assert.equal(shellBlockReasonMessage({ type: "unsafeResolution", message: "unsafe" }), "unsafe")
  assert.match(shellBlockReasonMessage({ type: "adminCommandDenylist", pattern: "npm:install *" }), /denylist rule: npm:install \*/)
  assert.equal(shellBlockReasonMessage({ type: "needsApproval" }), "Command is not allowed")
  assert.equal(shellBlockReasonMessage({ type: "cursorIgnore" }), "Command is not allowed")
})

test("a command blocked by a read-only session is a permission denial rather than a rejection", () => {
  const denied = shellCommandBlockResult("rm -rf /", "/repo", { type: "permissionsConfig", isReadonly: true })
  assert.equal(denied.case, "permissionDenied")
  assert.equal(denied.value?.isReadonly, true)
  assert.equal(denied.value?.command, "rm -rf /")

  // The same block without the read-only marker is an ordinary rejection.
  const rejected = shellCommandBlockResult("rm -rf /", "/repo", { type: "permissionsConfig" })
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
  for await (const _event of withEnv.execute(createContext(), { command: "ls", sandboxPolicy: { perRepo: { type: "workspace_readwrite" } } })) {
    void _event
  }
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
