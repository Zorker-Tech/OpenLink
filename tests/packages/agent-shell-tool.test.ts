import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SHELL_TOOL_FACTORY_PLACEMENT,
  ShellToolPermissionDeniedError,
  ShellToolRejectedError,
  ShellToolTimeoutError,
  createShellTool,
  type ShellToolExecutionMeta,
  type ShellToolInteractionHandler,
  type ShellToolOptions,
} from "../../source/packages/agent/tools/core/shell/create-shell-tool.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { shellStreamExecutorResource } from "../../source/packages/agent-exec/shell-stream-operation.ts"
import {
  ShellStream,
} from "../../source/packages/proto/generated/agent/v1/shell_exec_pb.ts"
import { SandboxPolicy_Type } from "../../source/packages/proto/generated/agent/v1/sandbox_pb.ts"
import type { ShellResult } from "../../source/packages/proto/generated/agent/v1/shell_exec_pb.ts"
import { ToolCall } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const ctx = createContext()

const stdout = (data: string) => new ShellStream({ event: { case: "stdout", value: { data } } as never })
const stderr = (data: string) => new ShellStream({ event: { case: "stderr", value: { data } } as never })
const exit = (code: number, extra: Record<string, unknown> = {}) =>
  new ShellStream({ event: { case: "exit", value: { code, aborted: false, localExecutionTimeMs: 12, ...extra } } as never })
const backgrounded = (fields: Record<string, unknown>) =>
  new ShellStream({ event: { case: "backgrounded", value: { command: "npm run watch", workingDirectory: "/repo", shellId: 3, ...fields } } as never })

/** An executor that answers with the events the test asks for, and records what it was asked. */
function executor(events: ShellStream[] | { throw: unknown }) {
  const calls: Array<{ args: unknown; options: unknown }> = []
  return {
    calls,
    executor: {
      async *execute(_ctx: Context, args: unknown, options: unknown) {
        calls.push({ args, options })
        if (!Array.isArray(events)) throw events.throw
        for (const event of events) yield event
      },
    },
  }
}

const accessor = (implementation: unknown) => ({ get: () => implementation })

function interaction(options: { aborted?: boolean; onExecute?: (call: ToolCall) => void } = {}) {
  const partials: ToolCall[] = []
  return {
    partials,
    handler: {
      async executeToolCall(_ctx: Context, call: ToolCall, _id: string, run: (ctx: Context) => Promise<ShellResult>) {
        options.onExecute?.(call)
        return await run(_ctx)
      },
      getAbortSignal: () => ({ aborted: options.aborted === true }) as AbortSignal,
      async emitPartialToolCall(_ctx: Context, _id: string, call: ToolCall) { partials.push(call) },
    } as unknown as ShellToolInteractionHandler,
  }
}

const tool = (options: ShellToolOptions, events: ShellStream[] | { throw: unknown } = [exit(0)]) => {
  const recorded = executor(events)
  return { recorded, built: createShellTool(accessor(recorded.executor) as never, options) }
}

async function run(
  built: Record<string, unknown>,
  args: Record<string, unknown>,
  handler = interaction().handler,
  meta: ShellToolExecutionMeta = { toolCallId: "call-1" },
): Promise<ShellResult> {
  const execute = built.execute as (ctx: Context, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<ShellResult>
  const stream = (async function* () { yield JSON.stringify(args) })()
  return await execute(ctx, handler, stream, meta)
}

const argsOf = (call: ToolCall) => {
  assert.equal(call.tool.case, "shellToolCall")
  return (call.tool as { value: { args: Record<string, unknown> } }).value.args
}

// ---------------------------------------------------------------------------------------------
// the tool a session gets
// ---------------------------------------------------------------------------------------------

test("the tool is named for the surface it runs on", () => {
  assert.equal(tool({}).built?.name, "run_terminal_cmd")
  assert.equal(tool({ surface: "isolated_box" }).built?.name, "run-command")
  assert.equal(tool({ toolName: "Shell" }).built?.name, "Shell")
  assert.equal(tool({}).built?.toolIdentifier, "SHELL")
})

test("a platform that cannot run the tool is not given it", () => {
  assert.equal(createShellTool(accessor(executor([]).executor) as never, { isPlatformEnabled: () => false }), undefined)
  assert.notEqual(tool({ isPlatformEnabled: () => true }).built, undefined)
})

test("the placement says where the tool belongs in a session", () => {
  assert.equal(SHELL_TOOL_FACTORY_PLACEMENT, "turn-toolset:externalShell|boxShell")
})

// ---------------------------------------------------------------------------------------------
// what the model is asked for
// ---------------------------------------------------------------------------------------------

test("a command that succeeds comes back as its own output and exit code", async () => {
  const { recorded, built } = tool({}, [stdout("hello\n"), stderr("careful\n"), exit(0)])
  const result = await run(built as Record<string, unknown>, { command: "echo hello" })
  assert.equal(result.result.case, "success")
  const value = (result.result as { value: { stdout: string; stderr: string; exitCode: number; interleavedOutput: string } }).value
  assert.equal(value.stdout, "hello\n")
  assert.equal(value.stderr, "careful\n")
  // What the user would have seen is the two streams in the order they arrived.
  assert.equal(value.interleavedOutput, "hello\ncareful\n")
  assert.equal(value.exitCode, 0)
  assert.equal(recorded.calls.length, 1)
})

test("a command that fails is a failure rather than an error", async () => {
  const { built } = tool({}, [stdout("boom\n"), exit(1)])
  const result = await run(built as Record<string, unknown>, { command: "false" })
  assert.equal(result.result.case, "failure")
  assert.equal((result.result as { value: { exitCode: number } }).value.exitCode, 1)
})

test("a command that was stopped says so", async () => {
  const { built } = tool({}, [exit(143, { aborted: true, abortReason: 1 })])
  const result = await run(built as Record<string, unknown>, { command: "sleep 100" })
  assert.equal(result.result.case, "failure")
  const value = (result.result as { value: { aborted?: boolean; signal: string } }).value
  assert.equal(value.aborted, true)
  assert.equal(value.signal, "SIGTERM")
})

test("a stream that ends without an exit is not a result", async () => {
  const { built } = tool({}, [stdout("partial")])
  await assert.rejects(() => run(built as Record<string, unknown>, { command: "echo partial" }), /without an exit event/)
})

test("a command that is moved to the background answers with the shell to watch", async () => {
  const { built } = tool({}, [stdout("starting\n"), backgrounded({ pid: 42, msToWait: 5, reason: 1 })])
  const recorded = interaction()
  const result = await run(built as Record<string, unknown>, { command: "npm run watch" }, recorded.handler)
  assert.equal(result.result.case, "success")
  const value = (result.result as { value: { shellId: number; pid?: number; stdout: string } }).value
  assert.equal(value.shellId, 3)
  assert.equal(value.pid, 42)
  assert.equal(value.stdout, "starting\n")
  assert.equal(result.isBackground, true)
  // The user is shown the call as soon as it is known to be a background one.
  assert.equal(recorded.partials.length, 1)
})

test("the command is sent with everything the parser found in it", async () => {
  const { recorded, built } = tool({})
  await run(built as Record<string, unknown>, { command: "git status && ls > /dev/null", working_directory: "/repo" })
  const args = recorded.calls[0]?.args as { command: string; workingDirectory: string; simpleCommands: string[]; hasOutputRedirect: boolean; parsingResult: { hasRedirects: boolean; allRedirectsAreDevNull?: boolean } }
  assert.equal(args.command, "git status && ls > /dev/null")
  assert.equal(args.workingDirectory, "/repo")
  assert.deepEqual(args.simpleCommands, ["git", "ls"])
  assert.equal(args.hasOutputRedirect, true)
  assert.equal(args.parsingResult.hasRedirects, true)
  assert.equal(args.parsingResult.allRedirectsAreDevNull, true)
})

test("a description is passed on under the name its prompt version uses", async () => {
  // The later prompt versions ask for a description; the earliest asks for an explanation instead.
  const later = tool({})
  await run(later.built as Record<string, unknown>, { command: "ls", description: "list the files" })
  assert.equal((later.recorded.calls[0]?.args as { description?: string }).description, "list the files")
  const earliest = tool({ promptVersion: "dsv3-1018" })
  await run(earliest.built as Record<string, unknown>, { command: "ls", is_background: false, explanation: "list the files" })
  assert.equal((earliest.recorded.calls[0]?.args as { description?: string }).description, "list the files")
})

test("a field the prompt version does not ask for is not passed on", async () => {
  // The later versions have no explanation field, so one the model sends anyway is dropped rather than
  // smuggled through to the executor.
  const later = tool({})
  await run(later.built as Record<string, unknown>, { command: "ls", explanation: "list the files" })
  assert.equal((later.recorded.calls[0]?.args as { description?: string }).description, undefined)
})

test("a command that starts in the background does not wait for its output", async () => {
  const { recorded, built } = tool({})
  await run(built as Record<string, unknown>, { command: "npm run watch", is_background: true })
  const args = recorded.calls[0]?.args as { isBackground: boolean }
  assert.equal(args.isBackground, true)
})

// ---------------------------------------------------------------------------------------------
// what a command is allowed to ask for
// ---------------------------------------------------------------------------------------------

test("a session without a sandbox is not given a policy", async () => {
  const { recorded, built } = tool({})
  await run(built as Record<string, unknown>, { command: "ls", required_permissions: ["all"] })
  assert.equal((recorded.calls[0]?.args as { requestedSandboxPolicy?: unknown }).requestedSandboxPolicy, undefined)
})

test("a sandboxed session gets the policy the command asked for", async () => {
  const asked = async (args: Record<string, unknown>) => {
    const { recorded, built } = tool({ sandboxEnabled: true })
    await run(built as Record<string, unknown>, args)
    return (recorded.calls[0]?.args as { requestedSandboxPolicy?: { type: number; networkAccess: boolean; additionalReadwritePaths: string[] } }).requestedSandboxPolicy
  }
  // Nothing asked for means a workspace it may write, without the network.
  const plain = await asked({ command: "ls" })
  assert.equal(plain?.type, SandboxPolicy_Type.WORKSPACE_READWRITE)
  assert.equal(plain?.networkAccess, false)
  const networked = await asked({ command: "curl example.com", required_permissions: ["network"] })
  assert.equal(networked?.networkAccess, true)
  // Asking for everything means no sandbox at all.
  assert.equal((await asked({ command: "ls", required_permissions: ["all"] }))?.type, SandboxPolicy_Type.INSECURE_NONE)
})

test("a read-only session is confined however much it asks for", async () => {
  const { recorded, built } = tool({ sandboxEnabled: true, isReadonly: true })
  await run(built as Record<string, unknown>, { command: "ls", required_permissions: ["network"] })
  const policy = (recorded.calls[0]?.args as { requestedSandboxPolicy: { type: number; networkAccess: boolean } }).requestedSandboxPolicy
  assert.equal(policy.type, SandboxPolicy_Type.WORKSPACE_READONLY)
  // The network is still what the command asked for, since reading a page changes nothing.
  assert.equal(policy.networkAccess, true)
})

test("a read-only session cannot even ask for everything", async () => {
  // The schema a read-only session is shown does not offer it, so a command that asks is refused as invalid.
  const { recorded, built } = tool({ sandboxEnabled: true, isReadonly: true })
  await assert.rejects(() => run(built as Record<string, unknown>, { command: "ls", required_permissions: ["all"] }), /required_permissions/)
  assert.deepEqual(recorded.calls, [])
})

test("the workspaces of the session are the ones a command may write", async () => {
  const { recorded, built } = tool({ sandboxEnabled: true })
  await run(built as Record<string, unknown>, { command: "ls" }, interaction().handler, { toolCallId: "call-1", workspacePaths: ["/repo", "/other"] })
  const policy = (recorded.calls[0]?.args as { requestedSandboxPolicy: { additionalReadwritePaths: string[] } }).requestedSandboxPolicy
  assert.deepEqual(policy.additionalReadwritePaths, ["/repo", "/other"])
})

test("a command that waits is planned by what it asked to wait for", async () => {
  const { recorded, built } = tool({ enableBlockUntilMs: true, defaultTimeoutMs: 30_000 })
  await run(built as Record<string, unknown>, { command: "npm test", block_until_ms: 5_000 })
  const args = recorded.calls[0]?.args as { timeout: number; isBackground: boolean }
  assert.equal(args.timeout, 5_000)
  assert.equal(args.isBackground, false)
  // A wait of nothing is a status check, which means the command has to be in the background to check.
  const checking = tool({ enableBlockUntilMs: true })
  await run(checking.built as Record<string, unknown>, { command: "npm test", block_until_ms: 0 })
  assert.equal((checking.recorded.calls[0]?.args as { isBackground: boolean }).isBackground, true)
})

// ---------------------------------------------------------------------------------------------
// the checks a command goes through
// ---------------------------------------------------------------------------------------------

test("a caller's own check can refuse a command, and is told what it refused", async () => {
  const seen: unknown[] = []
  const { recorded, built } = tool({
    preflight: async (_ctx, request) => {
      seen.push(request)
      return { allow: false, reason: "not that one" }
    },
  })
  await assert.rejects(
    () => run(built as Record<string, unknown>, { command: "rm -rf /", working_directory: "/repo" }),
    (error: unknown) => {
      assert.equal(error instanceof ShellToolRejectedError, true)
      assert.equal((error as ShellToolRejectedError).command, "rm -rf /")
      assert.equal((error as ShellToolRejectedError).reason, "not that one")
      return true
    },
  )
  // The check is given the command, where it runs, what it was parsed as and the policy it asked for.
  assert.equal((seen[0] as { command: string }).command, "rm -rf /")
  assert.equal((seen[0] as { workingDirectory?: string }).workingDirectory, "/repo")
  assert.equal((seen[0] as { analysis: { structured: { parsingFailed: boolean } } }).analysis.structured.parsingFailed, false)
  assert.deepEqual(recorded.calls, [])
})

test("the platform's own guard refuses a command that would look at the user's screen", async () => {
  const { recorded, built } = tool({ enforceModelFacingShellUiAutomationGuard: true })
  await assert.rejects(
    () => run(built as Record<string, unknown>, { command: "osascript -e 'tell application \"Finder\" to activate'" }),
    (error: unknown) => {
      assert.equal(error instanceof ShellToolRejectedError, true)
      return true
    },
  )
  assert.deepEqual(recorded.calls, [])
})

test("a command the executor refuses is answered as a refusal", async () => {
  const { built } = tool({}, [new ShellStream({ event: { case: "rejected", value: { command: "rm -rf /", workingDirectory: "/repo", reason: "the user said no" } } as never })])
  await assert.rejects(
    () => run(built as Record<string, unknown>, { command: "rm -rf /" }),
    (error: unknown) => {
      assert.equal(error instanceof ShellToolRejectedError, true)
      assert.equal((error as ShellToolRejectedError).reason, "the user said no")
      return true
    },
  )
})

test("a command the platform denies is answered as a denial", async () => {
  const { built } = tool({}, [new ShellStream({ event: { case: "permissionDenied", value: { command: "rm -rf /", workingDirectory: "/repo", error: "read-only", isReadonly: true } } as never })])
  await assert.rejects(
    () => run(built as Record<string, unknown>, { command: "rm -rf /" }),
    (error: unknown) => {
      assert.equal(error instanceof ShellToolPermissionDeniedError, true)
      assert.equal((error as ShellToolPermissionDeniedError).isReadonly, true)
      return true
    },
  )
})

test("a sandbox this machine cannot provide is an environment failure", async () => {
  const { built } = tool({}, [new ShellStream({ event: { case: "sandboxUnsupported", value: { reason: "no seatbelt here" } } as never })])
  await assert.rejects(() => run(built as Record<string, unknown>, { command: "ls" }), /no seatbelt here/)
})

test("a command that was aborted before it ran is not run", async () => {
  const { recorded, built } = tool({})
  await assert.rejects(
    () => run(built as Record<string, unknown>, { command: "ls" }, interaction({ aborted: true }).handler),
    /abort/i,
  )
  assert.deepEqual(recorded.calls, [])
})

// ---------------------------------------------------------------------------------------------
// what a failure looks like to the model
// ---------------------------------------------------------------------------------------------

test("every way a command can fail has its own result shape", () => {
  const built = tool({}).built as Record<string, unknown>
  const serialize = built.serializeError as (error: unknown) => ToolCall
  const cases: Array<[unknown, string]> = [
    [new ShellToolRejectedError("ls", "/repo", "no"), "rejected"],
    [new ShellToolPermissionDeniedError("ls", "/repo", "read-only", true), "permissionDenied"],
    [new ShellToolTimeoutError("sleep 100", "/repo", 1_000), "timeout"],
    [new Error("the shell is missing"), "spawnError"],
  ]
  for (const [error, expected] of cases) {
    const call = serialize(error)
    assert.equal(call.tool.case, "shellToolCall")
    const value = (call.tool as { value: { result: { result: { case?: string; value?: Record<string, unknown> } } } }).value
    assert.equal(value.result.result?.case, expected, expected)
  }
  // A timeout keeps the command and the time it was given.
  const timeout = serialize(new ShellToolTimeoutError("sleep 100", "/repo", 1_000))
  const timeoutValue = (timeout.tool as { value: { result: { result: { value: { timeoutMs: number; command: string } } } } }).value.result.result.value
  assert.equal(timeoutValue.timeoutMs, 1_000)
  assert.equal(timeoutValue.command, "sleep 100")
})

test("a result is rendered as the text the model reads", async () => {
  const built = tool({}).built as Record<string, unknown>
  const render = built.render as (ctx: Context, result: ShellResult) => Promise<{ content: Array<{ text: string }> }>
  const { built: other } = tool({}, [stdout("hello\n"), exit(0)])
  const result = await run(other as Record<string, unknown>, { command: "echo hello" })
  const rendered = await render(ctx, result)
  assert.match(rendered.content[0]?.text ?? "", /hello/)
  // A result that is not a result at all is reported as an unknown error rather than rendered.
  assert.equal(await render(ctx, { result: { case: undefined } } as never).then(r => r.content[0]?.text), "Unknown error")
})
