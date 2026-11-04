import { test } from "node:test"
import assert from "node:assert/strict"

import { createAwaitTool, type AwaitToolOptions } from "../../source/packages/agent/tools/core/await.ts"
import { ToolCallArgParseError } from "../../source/packages/agent/tools/tool-support.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import { lsExecutorResource } from "../../source/packages/agent-exec/ls.ts"
import { subagentExecutorResource } from "../../source/adapters/interop/agent/subagent-exec-adapter.ts"
import { subagentAwaitExecutorResource } from "../../source/packages/agent-exec/subagent-await.ts"
import { ReadResult, ReadSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts"
import { LsResult, LsSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/ls_exec_pb.ts"
import { SubagentAwaitComplete, SubagentAwaitResult, SubagentAwaitStillRunning } from "../../source/adapters/interop/proto/generated/agent/v1/subagent_exec_pb.ts"
import { AwaitResult } from "../../source/adapters/interop/proto/generated/agent/v1/await_tool_pb.ts"
import type { TextResult } from "../../source/packages/chat-inference/prompt-executor.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

type Tool = Record<string, unknown>

const TERMINALS = "/repo/.slate/projects/workspace-1/terminals"
const TRANSCRIPTS = "/repo/.slate/projects/workspace-1/agent-transcripts"

const footer = (exitCode: number, elapsedMs: number) => `\n---\nexit_code: ${exitCode}\nelapsed_ms: ${elapsedMs}\n---\n`
const header = (runningForMs: number) => `---\npid: 1234\nrunning_for_ms: ${runningForMs}\n---\n`

function harness(options: {
  files?: Record<string, string>
  /** Contents that change between reads, which is how a job that finishes during a wait is modelled. */
  sequence?: Record<string, string[]>
  listing?: unknown
  subagentAwait?: SubagentAwaitResult | "throw"
  subagentResume?: unknown
  readError?: "permissionDenied" | "rejected" | "invalidFile" | "error"
  readData?: boolean
  fileSizes?: Record<string, number>
  listingTimeout?: boolean
  tool?: Partial<AwaitToolOptions>
  promptVersion?: string
} = {}) {
  const files = options.files ?? {}
  const sequences = options.sequence ?? {}
  const readCounts = new Map<string, number>()
  const reads: string[] = []
  const subagentCalls: unknown[] = []
  let listingCalls = 0
  const accessor = {
    get: (resource: unknown) => {
      if (resource === readExecutorResource) {
        return {
          async execute(_ctx: Context, args: { path: string }) {
            reads.push(args.path)
            const sequence = sequences[args.path]
            let content = files[args.path]
            if (sequence !== undefined) {
              const index = readCounts.get(args.path) ?? 0
              readCounts.set(args.path, index + 1)
              content = sequence[Math.min(index, sequence.length - 1)]
            }
            if (content === undefined) return new ReadResult({ result: { case: "fileNotFound", value: {} } as never })
            if (options.readError !== undefined) return new ReadResult({ result: options.readError === "permissionDenied" ? { case: "permissionDenied", value: {} } as never : options.readError === "rejected" ? { case: "rejected", value: { reason: "denied by policy" } } as never : options.readError === "invalidFile" ? { case: "invalidFile", value: { reason: "not a file" } } as never : { case: "error", value: { error: "the read blew up" } } as never })
            return new ReadResult({
              result: {
                case: "success",
                value: new ReadSuccess({
                  path: args.path,
                  totalLines: content.split("\n").length,
                  fileSize: BigInt(options.fileSizes?.[args.path] ?? content.length),
                  output: options.readData === true ? { case: "data", value: Buffer.from(content) } : { case: "content", value: content },
                }),
              },
            })
          },
        }
      }
      if (resource === lsExecutorResource) {
        return {
          async execute() {
            listingCalls++
            if (options.listingTimeout === true) return new LsResult({ result: { case: "timeout", value: { directoryTreeRoot: options.listing } } as never })
            if (options.listing === undefined) return new LsResult({ result: { case: "fileNotFound", value: {} } as never })
            return new LsResult({ result: { case: "success", value: new LsSuccess({ directoryTreeRoot: options.listing as never }) } as never })
          },
        }
      }
      if (resource === subagentAwaitExecutorResource) {
        return {
          async execute(_ctx: Context, args: unknown) {
            subagentCalls.push(args)
            if (options.subagentAwait === "throw") throw new Error("no such subagent")
            return options.subagentAwait ?? new SubagentAwaitResult({ result: { case: "stillRunning", value: new SubagentAwaitStillRunning({}) } as never })
          },
        }
      }
      return {
        async execute(_ctx: Context, args: unknown) {
          subagentCalls.push(args)
          return options.subagentResume
        },
      }
    },
  }
  const meta = {
    toolCallId: "call-1",
    ...(options.tool !== undefined && "contextInjectionSignal" in options.tool
      ? { contextInjectionSignal: options.tool.contextInjectionSignal }
      : {}),
  }
  // A session always has a terminals folder unless a test says otherwise.
  const build = () => createAwaitTool(accessor as never, { terminalsFolder: TERMINALS, ...options.tool } as AwaitToolOptions, options.promptVersion ?? "latest") as Tool
  const call = async (args: Record<string, unknown>, ctx: Context = createContext()): Promise<AwaitResult> => {
    const tool = build()
    const execute = tool.execute as (ctx: unknown, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<AwaitResult>
    const stream = (async function* () { yield JSON.stringify(args) })()
    return await execute(ctx, { emitPartialToolCall() {}, async executeToolCall(_ctx: unknown, _call: unknown, _id: string, run: (ctx: unknown) => Promise<unknown>) { return await run(_ctx) } }, stream, meta)
  }
  const callWithMeta = async (args: Record<string, unknown>, extraMeta: Record<string, unknown>, ctx: Context = createContext()): Promise<AwaitResult> => {
    const tool = build()
    const execute = tool.execute as (ctx: unknown, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<AwaitResult>
    const stream = (async function* () { yield JSON.stringify(args) })()
    return await execute(ctx, { emitPartialToolCall() {}, async executeToolCall(_ctx: unknown, _call: unknown, _id: string, run: (ctx: unknown) => Promise<unknown>) { return await run(_ctx) } }, stream, { toolCallId: "call-1", ...extraMeta })
  }
  return { build, call, callWithMeta, reads, subagentCalls, meta, listingCalls: () => listingCalls }
}

const awaitResultOf = (result: AwaitResult) => {
  assert.equal(result.result.case, "success")
  const value = (result.result as { value: { awaitResult?: unknown } }).value.awaitResult
  return value as { case?: string; value?: Record<string, unknown> } | undefined
}

const renderOf = async (tool: Tool, result: AwaitResult): Promise<string> => {
  const render = tool.render as (ctx: unknown, value: AwaitResult) => Promise<TextResult>
  return (await render(createContext(), result)).content[0]?.text ?? ""
}

const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to fail")
}

// ---------------------------------------------------------------------------------------------
// the name, the schema and the description
// ---------------------------------------------------------------------------------------------

test("the tool is named for what it can wait on", () => {
  assert.equal(harness({ tool: { enableSubagentAwaiting: true } }).build().name, "Await")
  assert.equal(harness().build().name, "AwaitShell")
  assert.equal(harness({ tool: { enableSubagentAwaiting: true, toolName: "Wait" } }).build().name, "Wait")
  // A training prompt is shell-only by definition, whatever the options say.
  assert.equal(harness({ tool: { enableSubagentAwaiting: true, useTrainingShellOnlyPrompt: true } }).build().name, "Await")
  assert.equal(harness().build().toolIdentifier, "AWAIT")
})

test("a shell-only session is shown the shell's own argument name", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/42.txt`]: "the output\n" } })
  const result = await harnessed.call({ shell_id: "42", block_until_ms: 0 })
  assert.equal(awaitResultOf(result)?.value?.taskId, "42")
})

test("a task id sent as a number is read as one", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/42.txt`]: "the output\n" } })
  const result = await harnessed.call({ task_id: 42, block_until_ms: 0 })
  assert.equal(awaitResultOf(result)?.value?.taskId, "42")
})

test("a wait duration sent as a string is read as a number", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/42.txt`]: "the output\n" } })
  const result = await harnessed.call({ task_id: "42", block_until_ms: "0" })
  assert.equal(awaitResultOf(result)?.case, "stillRunning")
})

test("a required wait duration is required", async () => {
  const harnessed = harness({ tool: { requireBlockUntilMs: true } })
  const error = await failureOf(harnessed.call({ task_id: "42" }))
  assert.match(error.message, /block_until_ms/)
})

test("the description follows the session's tools and its notification policy", () => {
  const descriptionOf = (options: Partial<AwaitToolOptions>, props: Record<string, unknown> = {}) =>
    (harness({ tool: options }).build().descriptionGenerator as (props: Record<string, unknown>) => string)(props)

  // A session that is notified when jobs finish is told not to poll reflexively.
  const notified = descriptionOf({ enableJobCompletionNotifications: true }, { allTools: { SHELL: { name: "Shell" } } })
  assert.match(notified, /Prefer NOT to poll reflexively with AwaitShell/)
  assert.match(notified, /- Shell: only poll with AwaitShell when the command requires close monitoring/)
  // A session that is not is told how to poll well.
  const legacy = descriptionOf({}, { allTools: { SHELL: { name: "Shell" } } })
  assert.match(legacy, /Monitor backgrounded jobs as follows/)
  assert.match(legacy, /HARD STOPPING CONSTRAINT/)
  // No shell tool in the session means no shell guidance at all.
  assert.equal(descriptionOf({}, { allTools: {} }).includes("HARD STOPPING CONSTRAINT"), false)
})

test("the polling advice carries the prompt cache's own arithmetic", () => {
  const notified = (options: Partial<AwaitToolOptions>) =>
    (harness({ tool: options }).build().descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: { SHELL: { name: "Shell" } } })
  assert.match(notified({ enableJobCompletionNotifications: true, promptCacheTTLMs: 300_000 }), /avoid round 5-minute waits: prefer slices of 60–270s/)
  assert.match(notified({ enableJobCompletionNotifications: true, promptCacheTTLMs: 60_000 }), /avoid round 1-minute waits: prefer slices of up to 30s/)
  assert.match(notified({ enableJobCompletionNotifications: true, promptCacheTTLMs: 3_600_000 }), /avoid waiting 1h or more/)
})

test("a session with subagents is told never to wait on one", () => {
  const description = (options: Partial<AwaitToolOptions>, props: Record<string, unknown>) =>
    (harness({ tool: options }).build().descriptionGenerator as (props: Record<string, unknown>) => string)(props)
  const withSubagents = description({ enableSubagentAwaiting: true, enableJobCompletionNotifications: true }, { allTools: { SHELL: { name: "Shell" }, TASK: { name: "Task" } } })
  assert.match(withSubagents, /Subagents: never wait on a subagent with Await/)
  assert.match(withSubagents, /never wait on a subagent\)/)
  const withoutSubagents = description({ enableJobCompletionNotifications: true }, { allTools: { SHELL: { name: "Shell" }, TASK: { name: "Task" } } })
  assert.match(withoutSubagents, /NEVER USE THIS TO POLL OR WAIT VACUOUSLY FOR A SUBAGENT LAUNCHED WITH THE Task TOOL/)
})

test("the training prompt is the shell-only one", () => {
  const tool = harness({ tool: { useTrainingShellOnlyPrompt: true } }).build()
  assert.equal((tool.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: {} }), "Poll a background shell.")
})

test("a prompt version nobody wrote is refused", () => {
  const tool = harness({ promptVersion: "a-version-nobody-trained" }).build()
  assert.throws(() => (tool.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: {} }), /Unhandled version/)
})

// ---------------------------------------------------------------------------------------------
// sleeping without a task
// ---------------------------------------------------------------------------------------------

test("a wait with no task and no duration is refused", async () => {
  const error = await failureOf(harness().call({ block_until_ms: 0 }))
  assert.match(error.message, /Must pass a task id or wait for a nonzero duration/)
})

test("a wait with no task sleeps and says it slept", async () => {
  const harnessed = harness()
  const result = await harnessed.call({ block_until_ms: 30 })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.taskId, "")
  assert.equal(awaited?.value?.outputFilePath, "")
  assert.equal(awaited?.value?.regexRequested, false)
  assert.equal(await renderOf(harnessed.build(), result), "Slept briefly.")
})

test("a user message releases a sleep instead of waiting behind it", async () => {
  const harnessed = harness()
  const result = await harnessed.callWithMeta({ block_until_ms: 5_000 }, {
    contextInjectionSignal: { hasPendingUserInjections: () => true, onUserInjectionAdmitted: () => () => {} },
  })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.value?.wakeReason, "context_injection")
  assert.equal(await renderOf(harnessed.build(), result), "Slept briefly. Sleep released early: a new user message is arriving.")
})

// ---------------------------------------------------------------------------------------------
// a shell job
// ---------------------------------------------------------------------------------------------

test("a finished shell job reports its exit code and how long it ran", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/7.txt`]: `the output\n${footer(0, 4_200)}` } })
  const result = await harnessed.call({ task_id: "7", block_until_ms: 30_000 })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.exitCode, 0)
  assert.equal(awaited?.value?.runtimeMs, 4_200n)
  assert.equal(awaited?.value?.outputFilePath, `${TERMINALS}/7.txt`)
  assert.equal(awaited?.value?.outputLength, BigInt(`the output\n${footer(0, 4_200)}`.length))
  assert.match(await renderOf(harnessed.build(), result), /Task completed in 4200ms with exit code: 0\./)
})

test("a status check returns immediately with what the header says", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/7.txt`]: `${header(1_500)}still going\n` } })
  const result = await harnessed.call({ task_id: "7", block_until_ms: 0 })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "stillRunning")
  assert.equal(awaited?.value?.runtimeMs, 1_500n)
  assert.match(await renderOf(harnessed.build(), result), /Task still running after 1500ms\.\.\./)
})

test("a regex that matches the output ends the wait early", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/7.txt`]: `${header(10)}server ready on port 3000\n` } })
  const result = await harnessed.call({ task_id: "7", block_until_ms: 30_000, pattern: "ready on port (\\d+)" })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "stillRunning")
  assert.equal(awaited?.value?.regexMatch, "ready on port 3000")
  assert.equal(awaited?.value?.regexRequested, true)
})

test("a regex is matched against the output and not against the job's own bookkeeping", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/7.txt`]: `${header(10)}nothing interesting\n${footer(1, 20)}` } })
  // The word only appears in the footer, which is not part of what a pattern is matched against.
  const result = await harnessed.call({ task_id: "7", block_until_ms: 0, pattern: "exit_code" })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.regexMatch, undefined)
  assert.equal(awaited?.value?.exitCode, 1)
})

test("a wait keeps checking and returns as soon as the job finishes", async () => {
  const harnessed = harness({ sequence: { [`${TERMINALS}/7.txt`]: ["still going\n", "still going\n", `done\n${footer(0, 250)}`] } })
  const started = Date.now()
  const result = await harnessed.call({ task_id: "7", block_until_ms: 30_000 })
  assert.equal(awaitResultOf(result)?.case, "complete")
  // Two checks saw it running and one saw it finish, so the wait ended when the job did rather than when
  // the requested duration ran out.
  assert.equal(harnessed.reads.length, 3)
  const elapsed = Date.now() - started
  assert.equal(elapsed < 5_000, true)
  // Each check is a slice apart, so a wait does not spin on the read executor.
  assert.equal(elapsed >= 400, true)
})

test("a task id of none means there is no task", async () => {
  const harnessed = harness()
  const result = await harnessed.call({ task_id: "none", block_until_ms: 30 })
  assert.equal(awaitResultOf(result)?.case, "complete")
  assert.equal(awaitResultOf(result)?.value?.taskId, "")
})

test("a shell job that is not there is reported as such", async () => {
  const error = await failureOf(harness().call({ task_id: "7", block_until_ms: 0 }))
  assert.match(error.message, /No shell found for id 7/)
})

test("a wait with nowhere to look is refused", async () => {
  const harnessed = harness({ tool: { terminalsFolder: "" } })
  const error = await failureOf(harnessed.call({ task_id: "7", block_until_ms: 0 }))
  assert.match(error.message, /terminals folder is unavailable/)
})

// ---------------------------------------------------------------------------------------------
// an older client's argument
// ---------------------------------------------------------------------------------------------

test("a terminal file path is read as the id of that terminal", async () => {
  const harnessed = harness({ files: { [`${TERMINALS}/3.txt`]: "output\n" }, tool: { enableAwaitTerminalPathCompat: true } })
  const result = await harnessed.call({ path: `${TERMINALS}/3.txt`, block_until_ms: 0 })
  assert.equal(awaitResultOf(result)?.value?.taskId, "3")
})

test("a path that is not a terminal file is refused", async () => {
  const harnessed = harness({ tool: { enableAwaitTerminalPathCompat: true } })
  const error = await failureOf(harnessed.call({ path: "/repo/some/other.txt", block_until_ms: 0 }))
  assert.match(error.message, /path must be a path to a terminal file/)
})

// ---------------------------------------------------------------------------------------------
// a subagent
// ---------------------------------------------------------------------------------------------

test("a subagent id is refused by a session that cannot wait on subagents", async () => {
  const error = await failureOf(harness().call({ task_id: "agent-1", block_until_ms: 0 }))
  assert.equal(error instanceof ToolCallArgParseError, true)
  assert.match(error.message, /should NOT wait for subagents/)
})

test("a regex is refused for a subagent rather than ignored", async () => {
  const harnessed = harness({ tool: { enableSubagentAwaiting: true } })
  const error = await failureOf(harnessed.call({ task_id: "agent-1", block_until_ms: 0, pattern: "done" }, createContext().with(conversationIdKey, "conversation-1")))
  assert.match(error.message, /Regex awaiting is not available for subagents/)
})

test("waiting on a subagent needs a conversation to attach to", async () => {
  const harnessed = harness({ tool: { enableSubagentAwaiting: true, enableBoundedSubagentAwait: true } })
  const error = await failureOf(harnessed.call({ task_id: "agent-1", block_until_ms: 0 }))
  assert.match(error.message, /requires a non-empty conversationId/)
})

test("a subagent that finished reports its transcript", async () => {
  const transcript = `${TRANSCRIPTS}/agent-1.jsonl`
  const harnessed = harness({
    files: { [transcript]: "the transcript\n" },
    subagentAwait: new SubagentAwaitResult({
      result: { case: "complete", value: new SubagentAwaitComplete({ agentId: "agent-1", transcriptPath: transcript }) } as never,
    }),
    tool: { enableSubagentAwaiting: true, enableBoundedSubagentAwait: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const result = await harnessed.call({ task_id: "agent-1", block_until_ms: 1_000 }, createContext().with(conversationIdKey, "conversation-1"))
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.outputFilePath, transcript)
  assert.equal(awaited?.value?.outputLength, BigInt("the transcript\n".length))
  assert.equal(harnessed.subagentCalls.length, 1)
})

test("a subagent that finished without a transcript path reports none", async () => {
  // The executor's answer always carries the field, so a subagent that did not say where its transcript is
  // is reported as having none rather than searched for.
  const harnessed = harness({
    listing: { absPath: TRANSCRIPTS, childrenFiles: [{ name: "agent-2.jsonl" }], childrenDirs: [] },
    subagentAwait: new SubagentAwaitResult({
      result: { case: "complete", value: new SubagentAwaitComplete({ agentId: "agent-2" }) } as never,
    }),
    tool: { enableSubagentAwaiting: true, enableBoundedSubagentAwait: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const result = await harnessed.call({ task_id: "agent-2", block_until_ms: 1_000 }, createContext().with(conversationIdKey, "conversation-1"))
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.outputFilePath, "")
  assert.equal(awaited?.value?.outputLength, 0n)
  // The transcript is not looked for either: the answer said there is none.
  assert.equal(harnessed.listingCalls(), 0)
})

test("a subagent that has not finished is not reported as one that has", async () => {
  const harnessed = harness({
    subagentAwait: new SubagentAwaitResult({ result: { case: "stillRunning", value: new SubagentAwaitStillRunning({ agentId: "agent-1" }) } as never }),
    tool: { enableSubagentAwaiting: true, enableBoundedSubagentAwait: true },
  })
  const error = await failureOf(harnessed.call({ task_id: "agent-1", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1")))
  assert.match(error.message, /Failed to await subagent task/)
})

test("waiting for a subagent through the shell's signal is refused", async () => {
  const harnessed = harness({ tool: { fixClaudeSubagentAwait: true } })
  const error = await failureOf(harnessed.call({ shell_id: "42", block_until_ms: 0, waiting_for_subagent: true }))
  assert.match(error.message, /should NOT wait for subagents/)
})

// ---------------------------------------------------------------------------------------------
// what comes back
// ---------------------------------------------------------------------------------------------

test("a result is rendered for the model, whatever shape it has", async () => {
  const tool = harness().build()
  const complete = new AwaitResult({
    result: {
      case: "success",
      value: { awaitResult: { case: "complete", value: { taskId: "7", runtimeMs: 100n, outputFilePath: "/tmp/7.txt", outputLength: 5n } } } as never,
    },
  })
  assert.match(await renderOf(tool, complete), /Task completed in 100ms with exit code: unknown\./)
  const error = new AwaitResult({ result: { case: "error", value: { error: "the read failed" } } as never })
  assert.equal(await renderOf(tool, error), "Error awaiting task: the read failed")
  assert.equal(await renderOf(tool, new AwaitResult()), "Unknown error")
})

test("rendering a wire result preserves 64-bit durations and output lengths", async () => {
  const tool = harness().build()
  const runtimeMs = 9_007_199_254_740_993_123n
  const outputLength = 9_007_199_254_740_993_125n
  const result = new AwaitResult({
    result: {
      case: "success",
      value: {
        awaitResult: {
          case: "complete",
          value: { taskId: "large", runtimeMs, outputFilePath: "/tmp/large.txt", outputLength },
        },
      },
    } as never,
  })
  assert.equal(
    await renderOf(tool, result),
    `Task completed in ${runtimeMs}ms with exit code: unknown.\noutput_file_path: /tmp/large.txt\noutput_length: ${outputLength}`,
  )
})

test("a failure is serialized into the call's own error result", () => {
  const tool = harness().build()
  const call = (tool.serializeError as (error: unknown) => { tool: { case: string; value: { result?: { result?: { case?: string; value?: { error: string } } } } } })(new Error("the wait failed"))
  assert.equal(call.tool.case, "awaitToolCall")
  assert.equal(call.tool.value.result?.result?.case, "error")
  assert.equal(call.tool.value.result?.result?.value?.error, "the wait failed")
})

test("the default duration is used when the argument is missing", async () => {
  const harnessed = harness({ tool: { defaultBlockUntilMs: 12 } })
  const result = await harnessed.call({})
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.taskId, "")
})

test("a duration that is not a valid number falls back to the default", async () => {
  const harnessed = harness({ tool: { defaultBlockUntilMs: 12 } })
  const result = await harnessed.call({ block_until_ms: -5 })
  assert.equal(awaitResultOf(result)?.case, "complete")
  const fractional = harness({ tool: { defaultBlockUntilMs: 12 } })
  assert.equal(awaitResultOf(await fractional.call({ block_until_ms: 12.9 }))?.case, "complete")
})

test("a required duration must be sent", async () => {
  const harnessed = harness({ tool: { requireBlockUntilMs: true } })
  const error = await failureOf(harnessed.call({ task_id: "7" }))
  assert.equal(error instanceof ToolCallArgParseError, true)
})

test("the wait's call carries the request back to the client", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/42.txt"]: "output\n" } })
  const tool = harnessed.build()
  const execute = tool.execute as (ctx: unknown, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<AwaitResult>
  const merged: unknown[] = []
  const stream = (async function* () { yield JSON.stringify({ shell_id: "42", block_until_ms: 0, pattern: "done" }) })()
  await execute(createContext(), { emitPartialToolCall() {}, async executeToolCall(_ctx: unknown, _call: unknown, _id: string, run: (ctx: unknown) => Promise<unknown>, merge: (result: unknown) => unknown) { const result = await run(_ctx); merged.push(merge(result)); return result } }, stream, { toolCallId: "call-1" })
  const call = merged[0] as { tool: { case: string; value: { args?: { taskId?: string; blockUntilMs?: number; regex?: string }; result?: { result?: { case?: string } } } } }
  assert.equal(call.tool.case, "awaitToolCall")
  assert.equal(call.tool.value.args?.taskId, "42")
  assert.equal(call.tool.value.args?.blockUntilMs, 0)
  assert.equal(call.tool.value.args?.regex, "done")
  assert.equal(call.tool.value.result?.result?.case, "success")
})

test("a user message admitted during a slice releases it", async () => {
  let admit: (() => void) | undefined
  const signal = {
    hasPendingUserInjections: () => false,
    onUserInjectionAdmitted: (listener: () => void) => { admit = listener; return () => {} },
  }
  const harnessed = harness({ files: { [TERMINALS + "/43.txt"]: header(100) } })
  const started = Date.now()
  const promise = harnessed.callWithMeta({ task_id: "43", block_until_ms: 5_000 }, { contextInjectionSignal: signal })
  const timer = setTimeout(() => admit?.(), 60)
  const result = await promise
  clearTimeout(timer)
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "stillRunning")
  assert.equal(awaited?.value?.wakeReason, "context_injection")
  assert.equal(Date.now() - started < 2_000, true)
})

test("a regex is not matched against the file's metadata", async () => {
  const content = header(777) + "the body\n"
  const metadata = harness({ files: { [TERMINALS + "/44.txt"]: content } })
  const result = await metadata.call({ task_id: "44", block_until_ms: 250, pattern: "running_for_ms" })
  assert.equal(awaitResultOf(result)?.value?.regexMatch, undefined)
  const body = harness({ files: { [TERMINALS + "/44.txt"]: content } })
  const matched = await body.call({ task_id: "44", block_until_ms: 250, pattern: "the body" })
  assert.equal(awaitResultOf(matched)?.value?.regexMatch, "the body")
})

test("a matched output is reported up to five hundred characters", async () => {
  const long = "a".repeat(600)
  const harnessed = harness({ files: { [TERMINALS + "/45.txt"]: long } })
  const result = await harnessed.call({ task_id: "45", block_until_ms: 250, pattern: "a+" })
  const matched = awaitResultOf(result)?.value?.regexMatch as string
  assert.equal(matched.length, 500)
})

test("a malformed footer still finishes the wait without an exit code", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/46.txt"]: "out\n---\nexit_code: nope\nelapsed_ms: 12\n---\n" } })
  const result = await harnessed.call({ task_id: "46", block_until_ms: 5_000 })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.exitCode, undefined)
  assert.equal(awaited?.value?.runtimeMs, 12n)
})

test("a transcript in a nested directory is found by listing", async () => {
  const harnessed = harness({
    listing: { absPath: TRANSCRIPTS, childrenFiles: [], childrenDirs: [{ absPath: TRANSCRIPTS + "/run-1", childrenFiles: [{ name: "agent-5.jsonl" }], childrenDirs: [] }] },
    subagentResume: { result: { case: "complete", value: {} } },
    tool: { enableSubagentAwaiting: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const result = await harnessed.call({ task_id: "agent-5", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1"))
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.value?.outputFilePath, TRANSCRIPTS + "/run-1/agent-5.jsonl")
})

test("a function terminals folder is resolved when the wait needs it", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/47.txt"]: "output\n" }, tool: { terminalsFolder: () => TERMINALS, defaultBlockUntilMs: 0 } })
  const result = await harnessed.call({ task_id: "47" })
  assert.equal(awaitResultOf(result)?.value?.taskId, "47")
})

test("the polling advice falls back to plain guidance past six hours", () => {
  const tool = harness({ tool: { enableJobCompletionNotifications: true, promptCacheTTLMs: 21_700_000 } }).build()
  const description = (tool.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: { SHELL: { name: "Shell" } } })
  assert.match(description, /size slices based on expected progress/)
})

test("a pattern that is not a valid regex fails the wait", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/48.txt"]: "output\n" } })
  const error = await failureOf(harnessed.call({ task_id: "48", block_until_ms: 0, pattern: "[" }))
  assert.equal(error instanceof Error, true)
})

test("a non-error failure is serialized with its text", () => {
  const tool = harness().build()
  const call = (tool.serializeError as (error: unknown) => { tool: { value?: { result?: { result?: { case?: string; value?: { error: string } } } } } })("a plain failure")
  assert.equal(call.tool.value?.result?.result?.case, "error")
  assert.equal(call.tool.value?.result?.result?.value?.error, "a plain failure")
})

test("an id with letters is a subagent, not a shell", async () => {
  const harnessed = harness({
    subagentAwait: new SubagentAwaitResult({ result: { case: "complete", value: new SubagentAwaitComplete({ agentId: "abcdef" }) } as never }),
    tool: { enableSubagentAwaiting: true, enableBoundedSubagentAwait: true },
  })
  const result = await harnessed.call({ task_id: "abcdef", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1"))
  assert.equal(awaitResultOf(result)?.case, "complete")
})

test("a duration sent by the model is normalized before the handler sees it", async () => {
  const captured: Array<{ blockUntilMs?: number }> = []
  const run = async (args: Record<string, unknown>) => {
    const harnessed = harness({ tool: { defaultBlockUntilMs: 12 } })
    const tool = harnessed.build()
    const execute = tool.execute as (ctx: unknown, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<AwaitResult>
    const stream = (async function* () { yield JSON.stringify(args) })()
    await execute(createContext(), { emitPartialToolCall() {}, async executeToolCall(_ctx: unknown, _call: unknown, _id: string, runWork: (ctx: unknown) => Promise<unknown>, merge: (result: unknown) => unknown) { const result = await runWork(_ctx); const call = merge(result) as { tool: { value: { args: { blockUntilMs: number } } } }; captured.push(call.tool.value.args); return result } }, stream, { toolCallId: "call-1" })
  }
  await run({ block_until_ms: -5 })
  await run({ block_until_ms: 12.9 })
  assert.deepEqual(captured.map(call => call.blockUntilMs), [12, 12])
})

test("a footer whose exit code is a fraction reports no exit code", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/50.txt"]: "out\n---\nexit_code: 0.5\nelapsed_ms: 3\n---\n" } })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "50", block_until_ms: 0 }))
  assert.equal(awaited?.value?.exitCode, undefined)
})

test("a read that is refused by policy is reported with its reason", async () => {
  for (const [readError, pattern] of [["permissionDenied", /Permission denied reading/], ["rejected", /denied by policy/], ["invalidFile", /not a file/], ["error", /the read blew up/]] as const) {
    const harnessed = harness({ files: { [TERMINALS + "/51.txt"]: "output\n" }, readError })
    const error = await failureOf(harnessed.call({ task_id: "51", block_until_ms: 0 }))
    assert.match(error.message, pattern)
  }
})

test("a read that returns data is read as utf8 text and counted", async () => {
  const content = "hello\n"
  const harnessed = harness({ files: { [TERMINALS + "/52.txt"]: "out\n" + footer(4, 9) }, readData: true })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "52", block_until_ms: 0 }))
  assert.equal(awaited?.case, "complete")
  assert.equal(awaited?.value?.exitCode, 4)
})

test("a reported file size of zero falls back to the content length", async () => {
  const content = "hello\n"
  const harnessed = harness({ files: { [TERMINALS + "/53.txt"]: content }, fileSizes: { [TERMINALS + "/53.txt"]: 0 } })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "53", block_until_ms: 0 }))
  assert.equal(awaited?.value?.outputLength, BigInt(content.length))
})

test("a resume answer without a transcript path is searched for and left empty when nothing lists", async () => {
  const harnessed = harness({
    subagentResume: { result: { case: "complete", value: {} } },
    tool: { enableSubagentAwaiting: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "agent-x", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1")))
  assert.equal(awaited?.value?.outputFilePath, "")
  assert.equal(harnessed.listingCalls(), 1)
})

test("an empty transcripts folder is not searched", async () => {
  const harnessed = harness({
    subagentResume: { result: { case: "complete", value: {} } },
    tool: { enableSubagentAwaiting: true, agentTranscriptsFolder: "" },
  })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "agent-y", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1")))
  assert.equal(awaited?.value?.outputFilePath, "")
  assert.equal(harnessed.listingCalls(), 0)
})

test("a transcript under the parent conversation is found without listing", async () => {
  const conversationTranscript = TRANSCRIPTS + "/conversation-1/subagents/agent-6.jsonl"
  const harnessed = harness({
    files: { [conversationTranscript]: "transcript\n" },
    subagentResume: { result: { case: "complete", value: {} } },
    tool: { enableSubagentAwaiting: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "agent-6", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1")))
  assert.equal(awaited?.value?.outputFilePath, conversationTranscript)
  assert.equal(harnessed.listingCalls(), 0)
})

test("a failed transcript read does not fail the wait", async () => {
  const harnessed = harness({
    files: { [TRANSCRIPTS + "/agent-z.jsonl"]: "transcript\n" },
    subagentResume: { result: { case: "complete", value: {} } },
    readError: "error",
    tool: { enableSubagentAwaiting: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "agent-z", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1")))
  assert.equal(awaited?.value?.outputFilePath, "")
  assert.equal(harnessed.listingCalls(), 1)
})

test("a timed-out listing still finds a transcript", async () => {
  const harnessed = harness({
    listing: { absPath: TRANSCRIPTS, childrenFiles: [{ name: "agent-t.jsonl" }], childrenDirs: [] },
    listingTimeout: true,
    subagentResume: { result: { case: "complete", value: {} } },
    tool: { enableSubagentAwaiting: true, agentTranscriptsFolder: TRANSCRIPTS },
  })
  const awaited = awaitResultOf(await harnessed.call({ task_id: "agent-t", block_until_ms: 0 }, createContext().with(conversationIdKey, "conversation-1")))
  assert.equal(awaited?.value?.outputFilePath, TRANSCRIPTS + "/agent-t.jsonl")
})

test("a regex compiled with the multiline flag matches a later line", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/54.txt"]: "alpha\nbeta\n" } })
  const result = await harnessed.call({ task_id: "54", block_until_ms: 250, pattern: "^beta" })
  assert.equal(awaitResultOf(result)?.value?.regexMatch, "beta")
})

test("the schema tells a session with subagents what the id can be", () => {
  const tool = harness({ tool: { enableSubagentAwaiting: true } }).build()
  assert.match(JSON.stringify(tool.parameters), /shell or subagent/)
  const shellOnly = harness().build()
  assert.equal((JSON.stringify(shellOnly.parameters) as string).includes("shell or subagent"), false)
})

test("an older client's path does not override an id it was not sent with", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/3.txt"]: "output\n" }, tool: { enableAwaitTerminalPathCompat: true } })
  const error = await failureOf(harnessed.call({ task_id: "88", path: TERMINALS + "/3.txt", block_until_ms: 0 }))
  assert.match(error.message, /No shell found for id 88/)
})

test("a fractional cache lifetime is labelled to one decimal", () => {
  const tool = harness({ tool: { enableJobCompletionNotifications: true, promptCacheTTLMs: 5_450_000 } }).build()
  const description = (tool.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: { SHELL: { name: "Shell" } } })
  assert.match(description, /avoid waiting 1\.5h or more/)
})

test("a thirty-minute cache lifetime is on the minute boundary", () => {
  const tool = harness({ tool: { enableJobCompletionNotifications: true, promptCacheTTLMs: 1_800_000 } }).build()
  const description = (tool.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: { SHELL: { name: "Shell" } } })
  assert.match(description, /avoid round 30-minute waits/)
})

test("a six-hour cache lifetime is still on the hour boundary", () => {
  const tool = harness({ tool: { enableJobCompletionNotifications: true, promptCacheTTLMs: 21_600_000 } }).build()
  const description = (tool.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: { SHELL: { name: "Shell" } } })
  assert.match(description, /avoid waiting 6h or more/)
})

test("a pending user message ends a shell wait, not just a sleep", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/55.txt"]: header(100) } })
  const result = await harnessed.callWithMeta({ task_id: "55", block_until_ms: 300 }, {
    contextInjectionSignal: { hasPendingUserInjections: () => true, onUserInjectionAdmitted: () => () => {} },
  })
  const awaited = awaitResultOf(result)
  assert.equal(awaited?.value?.wakeReason, "context_injection")
  // The wait ends on the first slice rather than sleeping once more.
  assert.equal(harnessed.reads.length, 1)
})

test("a matched body ends the wait after one read", async () => {
  const harnessed = harness({ files: { [TERMINALS + "/56.txt"]: header(100) + "the body\n" } })
  const result = await harnessed.call({ task_id: "56", block_until_ms: 250, pattern: "the body" })
  assert.equal(awaitResultOf(result)?.value?.regexMatch, "the body")
  assert.equal(harnessed.reads.length, 1)
})

test("a status check reports a matched output cut to five hundred characters", async () => {
  const long = "a".repeat(600)
  const harnessed = harness({ files: { [TERMINALS + "/57.txt"]: long } })
  const result = await harnessed.call({ task_id: "57", block_until_ms: 0, pattern: "a+" })
  assert.equal((awaitResultOf(result)?.value?.regexMatch as string).length, 500)
})

test("a training prompt cannot wait on a subagent", async () => {
  const harnessed = harness({ tool: { useTrainingShellOnlyPrompt: true, enableSubagentAwaiting: true } })
  const error = await failureOf(harnessed.call({ task_id: "agent-9", block_until_ms: 0 }))
  assert.match(error.message, /should NOT wait for subagents/)
})

test("a session that switched awaiting off is shell-only", async () => {
  const harnessed = harness({ tool: { enableSubagentAwaiting: true, enableAwaitForSubagents: false } })
  assert.equal(harnessed.build().name, "AwaitShell")
  const error = await failureOf(harnessed.call({ task_id: "agent-8", block_until_ms: 0 }))
  assert.match(error.message, /should NOT wait for subagents/)
})

test("the default wait is told to the model as thirty seconds", () => {
  const tool = harness().build()
  assert.match(JSON.stringify(tool.parameters), /Defaults to 30000ms/)
})

test("a session that can signal waiting is told what the signal means", () => {
  const tool = harness({ tool: { fixClaudeSubagentAwait: true } }).build()
  assert.match(JSON.stringify(tool.parameters), /Set this to true if you are waiting for subagent\(s\) to complete/)
})
