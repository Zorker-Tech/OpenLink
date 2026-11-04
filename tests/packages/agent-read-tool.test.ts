import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { createReadTool, type ReadFormattingOptions, type ReadResourceAccessor } from "../../source/packages/agent/tools/core/read/read.ts"
import { readExecutorResource, redactedReadExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import type { Executor, ExecutorOptions } from "../../source/packages/agent-exec/executor-resources.ts"
import {
  ReadArgs,
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadRejected,
  ReadResult,
  ReadSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts"
import { ReadToolError, ReadToolResult, ReadToolSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_tool_pb.ts"
import type { BlobStore } from "../../source/packages/agent-kv/blob-store.ts"
import { agentEventTrackerKey, type AgentEventTracker, type SkillAppliedEvent } from "../../source/packages/agent/utils/event-tracking.ts"
import { READ_OUTPUT_BOUNDS } from "../../source/packages/agent/tools/read-limits.ts"
import type { CursorRule } from "../../source/adapters/interop/proto/generated/agent/v1/rules_pb.ts"

// ---------------------------------------------------------------------------------------------
// driving the tool the way the turn does: a fake executor, a fake interaction handler, real JSON
// ---------------------------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

interface TextResultLike {
  content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>
  isError: boolean
}

interface JsonSchemaLike {
  properties?: Record<string, unknown>
  required?: string[]
}

interface ReadToolLike {
  name: string
  parameters: { jsonSchema?: JsonSchemaLike }
  descriptionGenerator: () => string
  execute(ctx: Context, handler: unknown, argsStream: AsyncIterable<string>, meta: Record<string, unknown>): Promise<ReadToolResult>
  render(ctx: Context, value: ReadToolResult, props?: { blobStore?: BlobStore<Context> }): Promise<TextResultLike>
  serializeError(error: unknown): unknown
}

function asTool(tool: Record<string, unknown>): ReadToolLike {
  return tool as unknown as ReadToolLike
}

/** The JSON schema the model is shown, which is what decides the argument names it may send. */
function schemaOf(tool: ReadToolLike): JsonSchemaLike {
  return tool.parameters.jsonSchema ?? {}
}

interface ExecutorHarness {
  readonly executor: Executor<ReadArgs, ReadResult>
  readonly calls: ReadArgs[]
  readonly options: Array<ExecutorOptions | undefined>
}

function stubExecutor(responder: (args: ReadArgs) => ReadResult | Promise<ReadResult>): ExecutorHarness {
  const calls: ReadArgs[] = []
  const options: Array<ExecutorOptions | undefined> = []
  return {
    calls,
    options,
    executor: {
      async execute(_ctx, args, execOptions) {
        calls.push(args)
        options.push(execOptions)
        return await responder(args)
      },
    },
  }
}

/** Records which operation the tool resolved, so a redacted read can be told from an ordinary one. */
function accessorFor(executor: Executor<ReadArgs, ReadResult>): { accessor: ReadResourceAccessor; requested: symbol[] } {
  const requested: symbol[] = []
  return {
    requested,
    accessor: {
      get: (resource: { symbol: symbol }) => {
        requested.push(resource.symbol)
        return executor
      },
    } as unknown as ReadResourceAccessor,
  }
}

interface HandlerHarness {
  readonly emitted: unknown[]
  readonly recorded: unknown[]
}

/** The handler a turn supplies: it emits the in-progress call, runs the body, then records the result. */
function fakeHandler(harness: HandlerHarness = { emitted: [], recorded: [] }): HandlerHarness & {
  emitPartialToolCall(ctx: Context, toolCallId: string, call: unknown): void
  executeToolCall(
    ctx: Context,
    call: unknown,
    callId: string,
    execute: (ctx: Context) => Promise<ReadToolResult>,
    merge: (result: ReadToolResult) => unknown,
  ): Promise<ReadToolResult>
} {
  return {
    ...harness,
    emitPartialToolCall(_ctx, _toolCallId, call) {
      harness.emitted.push(call)
    },
    async executeToolCall(ctx, _call, _callId, execute, merge) {
      const result = await execute(ctx)
      harness.recorded.push(merge(result))
      return result
    },
  }
}

async function* argsStreamOf(args: unknown): AsyncIterable<string> {
  yield JSON.stringify(args)
}

function contentResult(content: string, overrides: {
  path?: string
  totalLines?: number
  fileSize?: number
  rangeApplied?: boolean
  outputBlobId?: Uint8Array
} = {}): ReadResult {
  return new ReadResult({
    result: {
      case: "success",
      value: new ReadSuccess({
        path: overrides.path ?? "/repo/file.txt",
        totalLines: overrides.totalLines ?? content.split("\n").length,
        fileSize: BigInt(overrides.fileSize ?? content.length),
        output: { case: "content", value: content },
        ...(overrides.rangeApplied === undefined ? {} : { rangeApplied: overrides.rangeApplied }),
        ...(overrides.outputBlobId === undefined ? {} : { outputBlobId: overrides.outputBlobId }),
      }),
    },
  })
}

function dataResult(bytes: Uint8Array, overrides: { path?: string; outputBlobId?: Uint8Array } = {}): ReadResult {
  return new ReadResult({
    result: {
      case: "success",
      value: new ReadSuccess({
        path: overrides.path ?? "/repo/image.png",
        totalLines: 0,
        fileSize: BigInt(bytes.byteLength),
        output: { case: "data", value: bytes },
        ...(overrides.outputBlobId === undefined ? {} : { outputBlobId: overrides.outputBlobId }),
      }),
    },
  })
}

function blobStoreHarness(): {
  readonly store: BlobStore<Context>
  readonly writes: Array<{ key: string; bytes: Uint8Array; locallyOnly: boolean }>
  readonly blobs: Map<string, Uint8Array>
  missing: boolean
} {
  const writes: Array<{ key: string; bytes: Uint8Array; locallyOnly: boolean }> = []
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (blobId: Uint8Array): string => Buffer.from(blobId).toString("hex")
  const harness = {
    writes,
    blobs,
    missing: false,
    store: {
      async getBlob(_ctx: Context, blobId: Uint8Array) {
        if (harness.missing) return undefined
        return blobs.get(keyOf(blobId))
      },
      async setBlob(_ctx: Context, blobId: Uint8Array, bytes: Uint8Array) {
        writes.push({ key: keyOf(blobId), bytes, locallyOnly: false })
        blobs.set(keyOf(blobId), bytes)
      },
      async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, bytes: Uint8Array) {
        writes.push({ key: keyOf(blobId), bytes, locallyOnly: true })
        blobs.set(keyOf(blobId), bytes)
      },
      async flush() {},
    } satisfies BlobStore<Context>,
  }
  return harness
}

function buildTool(
  responder: (args: ReadArgs) => ReadResult | Promise<ReadResult>,
  options: {
    version?: string
    formatting?: ReadFormattingOptions
    tool?: Record<string, unknown>
  } = {},
): { tool: ReadToolLike; harness: ExecutorHarness; requested: symbol[] } {
  const harness = stubExecutor(responder)
  const { accessor, requested } = accessorFor(harness.executor)
  const tool = createReadTool(accessor, options.formatting ?? {}, options.version ?? "latest", options.tool ?? {})
  return { tool: asTool(tool), harness, requested }
}

async function runRead(
  tool: ReadToolLike,
  args: unknown,
  meta: Record<string, unknown> = {},
  ctx: Context = createContext(),
): Promise<ReadToolResult> {
  return await tool.execute(ctx, fakeHandler(), argsStreamOf(args), { toolCallId: "call-1", ...meta })
}

const textOf = (result: TextResultLike): string => result.content.map(part => part.text ?? "").join("")

// ---------------------------------------------------------------------------------------------
// what the model sees: names, descriptions and arguments per prompt version
// ---------------------------------------------------------------------------------------------

test("each prompt version names the tool and its file argument the way that model expects", () => {
  const cases: Array<{ version: string; name: string; fileField: string }> = [
    { version: "dsv3-1018", name: "read_file", fileField: "target_file" },
    { version: "gpt5-codex", name: "ReadFile", fileField: "path" },
    { version: "codex-cloud", name: "ReadFile", fileField: "path" },
    { version: "cursor-0226", name: "Read", fileField: "path" },
    { version: "dsv3-1205", name: "Read", fileField: "path" },
    { version: "latest", name: "Read", fileField: "path" },
    { version: "haiku", name: "Read", fileField: "path" },
  ]
  for (const entry of cases) {
    const { tool } = buildTool(() => contentResult("x"), { version: entry.version })
    assert.equal(tool.name, entry.name, entry.version)
    // The file argument leads the schema, and it is the only one required.
    assert.equal(Object.keys(schemaOf(tool).properties ?? {})[0], entry.fileField, entry.version)
    assert.deepEqual(schemaOf(tool).required, [entry.fileField], entry.version)
  }
})

test("a version nothing is written for is refused rather than silently defaulted", () => {
  assert.throws(
    () => createReadTool(accessorFor(stubExecutor(() => contentResult("x")).executor).accessor, {}, "future-model"),
    /Unhandled version: future-model/,
  )
})

test("the minimal harness reads images only, and accepts any version", () => {
  const { tool } = buildTool(() => contentResult("x"), { version: "future-model", tool: { useMinimalHarness: true } })
  assert.equal(tool.name, "ViewImage")
  assert.deepEqual(Object.keys(schemaOf(tool).properties ?? {}), ["path"])
  assert.match(tool.descriptionGenerator(), /^Preview an image from a local path\./)
})

test("the line-number argument appears only when the version is told to offer it", () => {
  const withoutArg = buildTool(() => contentResult("x"), { tool: { enableLineNumbersArg: false } })
  assert.deepEqual(Object.keys(schemaOf(withoutArg.tool).properties ?? {}), ["path", "offset", "limit"])
  assert.match(withoutArg.tool.descriptionGenerator(), /LINE_NUMBER\|LINE_CONTENT/)

  const withArg = buildTool(() => contentResult("x"), { tool: { enableLineNumbersArg: true } })
  assert.deepEqual(Object.keys(schemaOf(withArg.tool).properties ?? {}), ["path", "offset", "limit", "include_line_numbers"])
  assert.doesNotMatch(withArg.tool.descriptionGenerator(), /LINE_NUMBER\|LINE_CONTENT/)
})

test("the haiku version asks for a line range instead of an offset and a limit", () => {
  const { tool } = buildTool(() => contentResult("x"), { version: "haiku" })
  assert.deepEqual(Object.keys(schemaOf(tool).properties ?? {}), ["path", "line_range"])
})

test("a caller may override the name and the description the tool presents", () => {
  const { tool } = buildTool(() => contentResult("x"), { tool: { toolName: "Peek", toolDescription: "Reads a little." } })
  assert.equal(tool.name, "Peek")
  assert.equal(tool.descriptionGenerator(), "Reads a little.")
})

test("a negative offset is refused unless the version accepts one", async () => {
  const plain = buildTool(() => contentResult("1\n2\n3"))
  await assert.rejects(() => runRead(plain.tool, { path: "/repo/file.txt", offset: -2 }), /offset: Offset must be >= 1\./)

  const allowed = buildTool(() => contentResult("1\n2\n3"), { tool: { enableNegativeOffset: true } })
  const result = await runRead(allowed.tool, { path: "/repo/file.txt", offset: -2 })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.output.case === "content" ? result.result.value.output.value : "", "2\n3")
})

// ---------------------------------------------------------------------------------------------
// asking for the file
// ---------------------------------------------------------------------------------------------

test("a read asks the workspace for the file and hands the range through", async () => {
  const { tool, harness } = buildTool(() => contentResult("one\ntwo\nthree"))
  const result = await runRead(tool, { path: "/repo/file.txt", offset: 2, limit: 2 })
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0]?.path, "/repo/file.txt")
  assert.equal(harness.calls[0]?.offset, 2)
  assert.equal(harness.calls[0]?.limit, 2)
  assert.equal(harness.calls[0]?.toolCallId, "call-1")
  assert.equal(result.result.case, "success")
  if (result.result.case !== "success") return
  assert.equal(result.result.value.output.case, "content")
  assert.equal(result.result.value.output.case === "content" ? result.result.value.output.value : "", "two\nthree")
  assert.equal(result.result.value.totalLines, 3)
  assert.equal(result.result.value.readRange?.startLine, 2)
  assert.equal(result.result.value.readRange?.endLine, 3)
})

test("the haiku line range becomes an offset and a limit", async () => {
  const { tool, harness } = buildTool(() => contentResult("one\ntwo\nthree\nfour"), { version: "haiku" })
  await runRead(tool, { path: "/repo/file.txt", line_range: [2, 3] })
  assert.equal(harness.calls[0]?.offset, 2)
  assert.equal(harness.calls[0]?.limit, 2)
})

test("the older file argument is accepted as the path", async () => {
  const { tool, harness } = buildTool(() => contentResult("x"), { version: "dsv3-1018" })
  await runRead(tool, { target_file: "/repo/legacy.txt" })
  assert.equal(harness.calls[0]?.path, "/repo/legacy.txt")
})

test("a range taken from the end of the file counts back from the last line", async () => {
  const { tool } = buildTool(() => contentResult("1\n2\n3\n4\n5"), { version: "cursor-0226" })
  const result = await runRead(tool, { path: "/repo/file.txt", offset: -2 })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.output.case === "content" ? result.result.value.output.value : "", "4\n5")
  assert.equal(result.result.value.readRange?.startLine, 4)
  assert.equal(result.result.value.readRange?.endLine, 5)
})

test("a range the workspace already applied is reported as it stands", async () => {
  const { tool } = buildTool(() => contentResult("two\nthree", { totalLines: 5, rangeApplied: true }))
  const result = await runRead(tool, { path: "/repo/file.txt", offset: 2, limit: 2 })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.output.case === "content" ? result.result.value.output.value : "", "two\nthree")
  assert.equal(result.result.value.totalLines, 5)
  assert.equal(result.result.value.readRange?.startLine, 2)
  assert.equal(result.result.value.readRange?.endLine, 3)
})

test("an offset past the end of the file is an error the model can act on", async () => {
  const { tool } = buildTool(() => contentResult("1\n2\n3\n4\n5"))
  await assert.rejects(
    () => runRead(tool, { path: "/repo/file.txt", offset: 10 }),
    /Offset 10 is beyond file length \(5 lines\)/,
  )
})

test("an empty file is reported as empty rather than as a file with one blank line", async () => {
  const { tool } = buildTool(() => contentResult("", { totalLines: 0 }))
  const result = await runRead(tool, { path: "/repo/empty.txt" })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.isEmpty, true)
  assert.equal(result.result.value.totalLines, 0)
  assert.equal(result.result.value.readRange, undefined)
  assert.equal(textOf(await tool.render(createContext(), result)), "File is empty.")
})

test("formats that are not text are refused before the workspace is asked", async () => {
  const { tool, harness } = buildTool(() => contentResult("x"))
  const result = await runRead(tool, { path: "/repo/archive.ZIP" })
  if (result.result.case !== "error") throw new Error("expected an error")
  assert.equal(result.result.value.errorMessage, "Cannot read binary files of type zip")
  assert.equal(harness.calls.length, 0)
})

test("content past the hard limit is withheld with the range it should be read in", async () => {
  const huge = "x".repeat(READ_OUTPUT_BOUNDS.maximumCharacters + 1)
  const { tool } = buildTool(() => contentResult(huge))
  const result = await runRead(tool, { path: "/repo/huge.txt" })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.exceededLimit, true)
  assert.equal(result.result.value.output.case === "content" ? result.result.value.output.value : "", "")
  const rendered = textOf(await tool.render(createContext(), result))
  assert.match(rendered, /exceeds maximum allowed characters/)
  assert.match(rendered, /use offset and limit parameters to read specific portions of the file/)
})

test("a workspace failure is turned into the error the model is shown", async () => {
  const { tool } = buildTool(() => new ReadResult({ result: { case: "error", value: new ReadError({ error: "disk on fire" }) } }))
  await assert.rejects(() => runRead(tool, { path: "/repo/file.txt" }), /disk on fire/)

  const rejected = buildTool(() => new ReadResult({ result: { case: "rejected", value: new ReadRejected({ reason: "not allowed" }) } }))
  await assert.rejects(() => runRead(rejected.tool, { path: "/repo/file.txt" }), /not allowed/)

  const missing = buildTool(() => new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({}) } }))
  await assert.rejects(() => runRead(missing.tool, { path: "/repo/file.txt" }), /File not found/)

  const denied = buildTool(() => new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({}) } }))
  await assert.rejects(() => runRead(denied.tool, { path: "/repo/file.txt" }), /Permission denied/)

  const invalid = buildTool(() => new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ reason: "" }) } }))
  await assert.rejects(() => runRead(invalid.tool, { path: "/repo/file.txt" }), /Path is not a valid file to read/)
})

test("a workspace that answers with nothing readable is refused", async () => {
  const { tool } = buildTool(() => new ReadResult({ result: { case: "success", value: new ReadSuccess({ path: "/repo/file.txt" }) } }))
  await assert.rejects(() => runRead(tool, { path: "/repo/file.txt" }), /Unknown output type/)
})

test("a redacted read is asked for under its own operation", () => {
  const { requested } = buildTool(() => contentResult("x"), { tool: { preferRedactedRead: true } })
  assert.deepEqual(requested, [redactedReadExecutorResource.symbol])

  const plain = buildTool(() => contentResult("x"))
  assert.deepEqual(plain.requested, [readExecutorResource.symbol])
})

// ---------------------------------------------------------------------------------------------
// what a read leaves behind: the recorded path, the rules and the skills that belong to the file
// ---------------------------------------------------------------------------------------------

test("a successful read is recorded on the conversation and deduplicated within the step", async () => {
  const { tool } = buildTool(() => contentResult("x", { path: "/repo/src/app.ts" }))
  const recorded: Array<{ value: string }> = []
  const dedup = new Set<string>()
  await runRead(tool, { path: "/repo/src/app.ts" }, {
    stateHandler: { recordReadPath: (path: { value: string }) => recorded.push(path) },
    stepReadPathDedup: dedup,
  })
  assert.deepEqual(recorded.map(path => path.value), ["/repo/src/app.ts"])
  assert.deepEqual(Array.from(dedup), ["/repo/src/app.ts"])
})

test("the rules that belong to the file are attached to the result and shown with it", async () => {
  const rules = [
    { fullPath: "/repo/.cursor/rules/typescript.md", content: "Always use strict types.\n" },
    { fullPath: "/repo/.cursor/rules/other.md", content: "Not about this file." },
  ] as unknown as CursorRule[]
  const { tool } = buildTool(() => contentResult("x", { path: "/repo/.cursor/rules/typescript.md" }))
  const result = await runRead(tool, { path: "/repo/.cursor/rules/typescript.md" }, { cursorRules: rules })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.relatedCursorRules.length, 1)
  assert.equal(result.result.value.relatedCursorRules[0]?.fullPath, "/repo/.cursor/rules/typescript.md")
  assert.deepEqual(result.result.value.relatedCursorRulePaths, ["/repo/.cursor/rules/typescript.md"])
  const rendered = textOf(await tool.render(createContext(), result))
  assert.match(rendered, /The following rule files are relevant to the files you just read:/)
  assert.match(rendered, /Always use strict types\./)
  assert.match(rendered, /Consider these rules if they affect your changes\./)
  assert.doesNotMatch(rendered, /Not about this file\./)
})

test("the skills that belong to the file are attached and shown with it, unless they are not invocable", async () => {
  const skills = [
    { fullPath: "/repo/.cursor/skills/release/SKILL.md", description: "Use when releasing." },
    { fullPath: "/repo/.cursor/skills/hidden/SKILL.md", description: "Hidden.", disableModelInvocation: true },
  ]
  const { tool } = buildTool(() => contentResult("x", { path: "/repo/.cursor/skills/release/SKILL.md" }))
  const result = await runRead(tool, { path: "/repo/.cursor/skills/release/SKILL.md" }, { agentSkills: skills })
  if (result.result.case !== "success") throw new Error("expected a success")
  const rendered = textOf(await tool.render(createContext(), result))
  assert.match(rendered, /The following skills may be relevant to the files you just read:/)
  assert.match(rendered, /Use when releasing\./)
  assert.doesNotMatch(rendered, /Hidden\./)
})

test("reading a skill file records that the skill was used, with where it came from", async () => {
  const applied: SkillAppliedEvent[] = []
  const used: unknown[] = []
  const tracker = {
    trackSkillApplied: (_ctx: Context, event: SkillAppliedEvent) => applied.push(event),
    trackSkillUsed: (...args: unknown[]) => used.push(args),
  } as unknown as AgentEventTracker
  const ctx = createContext().with(agentEventTrackerKey, tracker)
  const skills = [{ fullPath: "/repo/.cursor/skills/release/SKILL.md", description: "Use when releasing." }]
  const { tool } = buildTool(() => contentResult("x", { path: "/repo/.cursor/skills/release/SKILL.md" }))
  await runRead(tool, { path: "/repo/.cursor/skills/release/SKILL.md" }, { agentSkills: skills }, ctx)
  assert.equal(used.length, 1)
  assert.equal(applied.length, 1)
  assert.equal(applied[0]?.entrypoint, "agent_read")
  assert.equal(applied[0]?.skillId, "release")
  assert.equal(applied[0]?.skillSource, "workspace")
})

test("a file that is not a skill records no skill use", async () => {
  const applied: SkillAppliedEvent[] = []
  const tracker = { trackSkillApplied: (_ctx: Context, event: SkillAppliedEvent) => applied.push(event) } as unknown as AgentEventTracker
  const ctx = createContext().with(agentEventTrackerKey, tracker)
  const { tool } = buildTool(() => contentResult("x", { path: "/repo/src/app.ts" }))
  await runRead(tool, { path: "/repo/src/app.ts" }, {}, ctx)
  assert.deepEqual(applied, [])
})

test("the call the turn records carries the arguments and the result", async () => {
  const { tool } = buildTool(() => contentResult("x", { path: "/repo/file.txt" }))
  const handler = fakeHandler()
  await tool.execute(createContext(), handler, argsStreamOf({ path: "/repo/file.txt" }), { toolCallId: "call-9" })
  assert.equal(handler.emitted.length, 1)
  const emitted = handler.emitted[0] as { tool?: { case?: string } }
  assert.equal(emitted.tool?.case, "readToolCall")
  const recorded = handler.recorded[0] as { tool?: { case?: string; value?: { args?: { path?: string }; result?: { result?: { case?: string } } } } }
  assert.equal(recorded.tool?.case, "readToolCall")
  assert.equal(recorded.tool?.value?.args?.path, "/repo/file.txt")
  assert.equal(recorded.tool?.value?.result?.result?.case, "success")
})

test("an error is serialized as a read call carrying the message", () => {
  const { tool } = buildTool(() => contentResult("x"))
  const serialized = tool.serializeError(new Error("boom")) as { tool?: { case?: string; value?: { result?: ReadToolResult } } }
  assert.equal(serialized.tool?.case, "readToolCall")
  assert.equal(serialized.tool?.value?.result?.result.case, "error")
  assert.equal(
    serialized.tool?.value?.result?.result.case === "error" ? serialized.tool.value.result.result.value.errorMessage : "",
    "boom",
  )
})

// ---------------------------------------------------------------------------------------------
// large content and images: what travels in the conversation and what is kept in a blob
// ---------------------------------------------------------------------------------------------

test("a large file is kept in a blob and referred to by its id", async () => {
  const content = "y".repeat(20_000)
  const blobs = blobStoreHarness()
  const { tool } = buildTool(() => contentResult(content))
  const result = await runRead(tool, { path: "/repo/big.txt" }, { stateHandler: { getBlobStore: () => blobs.store } })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.output.case, "contentBlobId")
  assert.equal(blobs.writes.length, 1)
  assert.equal(blobs.writes[0]?.locallyOnly, false)
  assert.equal(Buffer.from(blobs.writes[0]?.bytes ?? new Uint8Array()).toString("utf8"), content)

  const rendered = textOf(await tool.render(createContext(), result, { blobStore: blobs.store }))
  assert.equal(rendered, content)
})

test("content the workspace already addressed by blob id is written without waiting for replication", async () => {
  const content = "z".repeat(20_000)
  const blobId = new Uint8Array([1, 2, 3, 4])
  const blobs = blobStoreHarness()
  const { tool } = buildTool(() => contentResult(content, { outputBlobId: blobId }))
  const result = await runRead(tool, { path: "/repo/big.txt" }, { stateHandler: { getBlobStore: () => blobs.store } })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.output.case, "contentBlobId")
  assert.deepEqual(result.result.value.output.case === "contentBlobId" ? result.result.value.output.value : undefined, blobId)
  assert.equal(blobs.writes[0]?.locallyOnly, true)
})

test("a small file travels in the conversation rather than through a blob", async () => {
  const blobs = blobStoreHarness()
  const { tool } = buildTool(() => contentResult("small"))
  const result = await runRead(tool, { path: "/repo/small.txt" }, { stateHandler: { getBlobStore: () => blobs.store } })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.output.case, "content")
  assert.equal(blobs.writes.length, 0)
})

test("an image is kept in a blob when a store is available and sent as bytes when it is not", async () => {
  const blobs = blobStoreHarness()
  const withStore = buildTool(() => dataResult(PNG_BYTES))
  const stored = await runRead(withStore.tool, { path: "/repo/image.png" }, { stateHandler: { getBlobStore: () => blobs.store } })
  if (stored.result.case !== "success") throw new Error("expected a success")
  assert.equal(stored.result.value.output.case, "dataBlobId")
  assert.equal(blobs.writes.length, 1)

  const withoutStore = buildTool(() => dataResult(PNG_BYTES))
  const inline = await runRead(withoutStore.tool, { path: "/repo/image.png" })
  if (inline.result.case !== "success") throw new Error("expected a success")
  assert.equal(inline.result.value.output.case, "data")
})

test("an image is rendered as an image the model can see", async () => {
  const blobs = blobStoreHarness()
  const { tool } = buildTool(() => dataResult(PNG_BYTES))
  const result = await runRead(tool, { path: "/repo/image.png" }, { stateHandler: { getBlobStore: () => blobs.store } })
  const rendered = await tool.render(createContext(), result, { blobStore: blobs.store })
  assert.equal(rendered.isError, false)
  const image = rendered.content.find(part => part.type === "image")
  assert.equal(image?.mimeType, "image/png")
  assert.equal(image?.data, Buffer.from(PNG_BYTES).toString("base64"))
  assert.match(textOf(rendered), /Read image file: \/repo\/image\.png/)
})

test("bytes that are not an image are named rather than sent", async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03])
  const { tool } = buildTool(() => dataResult(bytes, { path: "/repo/blob.dat" }))
  const result = await runRead(tool, { path: "/repo/blob.dat" })
  assert.equal(textOf(await tool.render(createContext(), result)), "Read binary file: /repo/blob.dat")
})

test("a blob that cannot be hydrated is an error rather than empty content", async () => {
  const content = "y".repeat(20_000)
  const blobs = blobStoreHarness()
  const { tool } = buildTool(() => contentResult(content))
  const result = await runRead(tool, { path: "/repo/big.txt" }, { stateHandler: { getBlobStore: () => blobs.store } })
  await assert.rejects(() => tool.render(createContext(), result), /no blob store available/)

  blobs.missing = true
  await assert.rejects(() => tool.render(createContext(), result, { blobStore: blobs.store }), /Failed to hydrate blob/)
})

// ---------------------------------------------------------------------------------------------
// PDFs: extracted to text, once per file
// ---------------------------------------------------------------------------------------------

test("a PDF is extracted to text and only extracted once", async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
  let extractions = 0
  const { tool } = buildTool(() => dataResult(bytes, { path: "/repo/doc.pdf" }), {
    tool: {
      pdfTextExtractor: async () => {
        extractions += 1
        return "first line\r\nsecond line"
      },
    },
  })
  const first = await runRead(tool, { path: "/repo/doc.pdf" })
  if (first.result.case !== "success") throw new Error("expected a success")
  assert.equal(first.result.value.output.case === "content" ? first.result.value.output.value : "", "first line\nsecond line")
  const second = await runRead(tool, { path: "/repo/doc.pdf" })
  if (second.result.case !== "success") throw new Error("expected a success")
  assert.equal(extractions, 1)
  assert.equal(textOf(await tool.render(createContext(), first)), "first line\nsecond line")
})

test("a PDF with no extractor bound is refused instead of being sent as bytes", async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
  const { tool } = buildTool(() => dataResult(bytes, { path: "/repo/doc.pdf" }))
  await assert.rejects(() => runRead(tool, { path: "/repo/doc.pdf" }), /Read PDF worker is not bound/)
})

// ---------------------------------------------------------------------------------------------
// how the text comes out
// ---------------------------------------------------------------------------------------------

test("text is written out with the line numbers the session asked for", async () => {
  const plain = buildTool(() => contentResult("alpha\nbeta"), { formatting: { enableLineNumbers: true } })
  const result = await runRead(plain.tool, { path: "/repo/file.txt" })
  assert.equal(textOf(await plain.tool.render(createContext(), result)), "     1|alpha\n     2|beta")
})

test("the line-number argument wins over the session default", async () => {
  const { tool } = buildTool(() => contentResult("alpha\nbeta"), {
    formatting: { enableLineNumbers: true },
    tool: { enableLineNumbersArg: true },
  })
  const result = await runRead(tool, { path: "/repo/file.txt", include_line_numbers: false })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.includeLineNumbers, false)
  assert.equal(textOf(await tool.render(createContext(), result)), "alpha\nbeta")
})

test("a sparse read numbers only every tenth line", async () => {
  const content = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join("\n")
  const { tool } = buildTool(() => contentResult(content), { formatting: { useSparseReadLineNumbers: true, enableLineNumbers: true } })
  const result = await runRead(tool, { path: "/repo/file.txt" })
  const lines = textOf(await tool.render(createContext(), result)).split("\n")
  assert.equal(lines[0], "line 1")
  assert.equal(lines[9], "    10|line 10")
  assert.equal(lines[10], "line 11")
})

test("a partial read says how much of the file is not shown", async () => {
  const { tool } = buildTool(() => contentResult("1\n2\n3\n4\n5"))
  const result = await runRead(tool, { path: "/repo/file.txt", offset: 2, limit: 2 })
  const rendered = textOf(await tool.render(createContext(), result))
  assert.equal(rendered, "... 1 line not shown ...\n2\n3\n... 2 lines not shown ...")
})

test("a notebook is written out as cells rather than as JSON", async () => {
  const notebook = JSON.stringify({
    cells: [
      { cell_type: "code", source: ["print('hi')\n"], outputs: [{ output_type: "stream", text: "hi\n" }] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  const rules = [{ fullPath: "/repo/nb.ipynb", content: "A rule for the notebook." }] as unknown as CursorRule[]
  const { tool } = buildTool(() => contentResult(notebook, { path: "/repo/nb.ipynb" }))
  const result = await runRead(tool, { path: "/repo/nb.ipynb" }, { cursorRules: rules })
  const rendered = textOf(await tool.render(createContext(), result))
  assert.match(rendered, /Cell 0:/)
  assert.match(rendered, /print\('hi'\)/)
  assert.match(rendered, /Cell 0 output:/)
  // A notebook's rules are not repeated beside it: the cells are the content the reader needs.
  assert.doesNotMatch(rendered, /A rule for the notebook\./)
})

test("a failure to read is rendered as an error rather than as content", async () => {
  const { tool } = buildTool(() => contentResult("x"))
  const failed = new ReadToolResult({ result: { case: "error", value: new ReadToolError({ errorMessage: "no such file" }) } })
  const rendered = await tool.render(createContext(), failed)
  assert.equal(rendered.isError, true)
  assert.equal(textOf(rendered), "Error: no such file")

  const unknown = new ReadToolResult({ result: { case: "success", value: new ReadToolSuccess({}) } })
  const unknownRendered = await tool.render(createContext(), unknown)
  assert.equal(unknownRendered.isError, true)
  assert.equal(textOf(unknownRendered), "Unknown error: no output case")
})
