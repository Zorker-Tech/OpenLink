import { test } from "node:test"
import assert from "node:assert/strict"

import { ShellCommandActionHandler } from "../../source/packages/agent/actions/shell-command-action-handler.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { fromRedactedCoreMessages } from "../../source/packages/redaction/message-redaction.ts"
import { shellStreamExecutorResource } from "../../source/packages/agent-exec/shell-stream-operation.ts"
import { requestContextExecutorResource } from "../../source/packages/agent-exec/request-context-operation.ts"
import { RequestContext } from "../../source/packages/proto/generated/agent/v1/request_context_exec_pb.ts"

// ---------------------------------------------------------------------------------------------
// the executor the handler streams through, and the transcript it writes
// ---------------------------------------------------------------------------------------------

interface StreamHarness {
  readonly calls: Array<{ args: unknown; options: unknown }>
  readonly resourcesAsked: unknown[]
  readonly updates: string[]
  readonly accessor: { get(resource: unknown): unknown }
}

function streamHarness(events: Array<Record<string, unknown>>, throwAfter?: number): StreamHarness {
  const calls: StreamHarness["calls"] = []
  const resourcesAsked: unknown[] = []
  const updates: string[] = []
  return {
    calls,
    resourcesAsked,
    updates,
    accessor: {
      // Other resources are asked for while the transcript is seeded, so the kind asked for is recorded
      // rather than asserted here.
      get: resource => {
        resourcesAsked.push(resource)
        // The first turn of a conversation is assembled from a request context, which is the one other
        // operation this file's seeding path needs.
        if (resource === requestContextExecutorResource) {
          return {
            async execute() {
              return { result: { case: "success", value: { requestContext: new RequestContext({}) } } }
            },
          }
        }
        return {
          execute(_ctx: Context, args: unknown, options: unknown) {
            calls.push({ args, options })
            return (async function* () {
              for (const [index, event] of events.entries()) {
                if (throwAfter !== undefined && index === throwAfter) throw new Error("the stream broke")
                yield event
              }
            })()
          },
        }
      },
    },
  }
}

interface TurnHarness {
  readonly outputs: Array<{ stdout: string; stderr: string; exitCode: number }>
  readonly turn: { recordShellOutput(output: unknown): void }
}

function turnHarness(): TurnHarness {
  const outputs: TurnHarness["outputs"] = []
  return {
    outputs,
    turn: {
      recordShellOutput(output: { stdout: { unwrap(p: PrivacyCapability): string }; stderr: { unwrap(p: PrivacyCapability): string }; exitCode: number }) {
        outputs.push({
          stdout: output.stdout.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          stderr: output.stderr.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          exitCode: output.exitCode,
        })
      },
    },
  }
}

/** The redaction layer reads the event's own fields, so the fakes carry the fields the proto has. */
const streamEvent = (text: string): { data: string } => ({ data: text })

function stateHandler(options: { dsv3?: boolean; messages?: unknown[] } = {}): {
  readonly structureCalls: number
  readonly handler: {
    mode: number
    createShellTurn(ctx: Context, command: unknown): Promise<TurnHarness["turn"]>
    computeNewStructure(ctx: Context): Promise<{ turns: unknown[] }>
    getPrivacyMode(): PrivacyMode
    getBlobStore(): undefined
    isDsv3(): boolean
  }
} {
  const holder = {
    structureCalls: 0,
    handler: {
      mode: 1,
      async createShellTurn() { return turnHarness().turn },
      async computeNewStructure() { holder.structureCalls += 1; return { turns: options.messages ?? [] } },
      getPrivacyMode: () => PrivacyMode.NO_STORAGE,
      getBlobStore: () => undefined,
      isDsv3: () => options.dsv3 === true,
    },
  }
  return holder
}

function executorHarness(initialMessages: unknown[] = [{ role: "user", content: "seed" }]): {
  readonly appended: unknown[][]
  readonly executor: { getMessages(): unknown[]; appendMessages(messages: unknown[]): void }
} {
  let messages = [...initialMessages]
  const appended: unknown[][] = []
  return {
    appended,
    executor: {
      getMessages: () => messages,
      appendMessages(next: unknown[]) { appended.push(next); messages = [...messages, ...next] },
    },
  }
}

/** What the executor was handed is stored redacted, so it is unwrapped before it is read. */
function plainMessages(messages: unknown[]): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  return fromRedactedCoreMessages(messages as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as never
}

const shellAction = (command: string, execId?: string): unknown => ({
  _privacyMode: PrivacyMode.NO_STORAGE,
  shellCommand: {
    command: createRedactedString(command, DataClassification.CODE, "command", PrivacyMode.NO_STORAGE),
  },
  ...(execId === undefined ? {} : { execId }),
})

function handlerWith(options: {
  events: Array<Record<string, unknown>>
  throwAfter?: number
  dsv3?: boolean
  config?: Record<string, unknown>
}): {
  readonly handler: ShellCommandActionHandler
  readonly streams: StreamHarness
  readonly updates: string[]
} {
  const streams = streamHarness(options.events, options.throwAfter)
  const updates: string[] = []
  const handler = new ShellCommandActionHandler(
    options.config ?? {},
    streams.accessor,
    { async sendUpdate() { updates.push("update") } },
    {},
    {},
  )
  return { handler, streams, updates }
}

// ---------------------------------------------------------------------------------------------
// running the command
// ---------------------------------------------------------------------------------------------

test("a shell command is run without an approval prompt", async () => {
  const { handler, streams } = handlerWith({ events: [] })
  const state = stateHandler()
  const executor = executorHarness()
  await handler.handle(createContext(), shellAction("ls -la"), executor.executor, state.handler, [], () => {})

  assert.equal(streams.calls.length, 1)
  assert.equal(streams.resourcesAsked.includes(shellStreamExecutorResource), true)
  const args = streams.calls[0]?.args as { command: string; skipApproval?: boolean }
  assert.equal(args.command, "ls -la")
  assert.equal(args.skipApproval, true)
  // No exec id means this is not a resumed turn, so the call carries none.
  assert.deepEqual(streams.calls[0]?.options, { execId: undefined })
})

test("the command's output is recorded as the turn's shell output", async () => {
  const { handler } = handlerWith({
    events: [
      { event: { case: "start", value: { sandboxPolicy: undefined } } },
      { event: { case: "stdout", value: streamEvent("out\n") } },
      { event: { case: "stderr", value: streamEvent("err\n") } },
      { event: { case: "exit", value: { code: 3, aborted: false } } },
    ],
  })
  const state = stateHandler()
  const executor = executorHarness()
  await handler.handle(createContext(), shellAction("make"), executor.executor, state.handler, [], () => {})

  // The recorded output is the one the transcript is written from, so it is checked through the messages.
  const transcript = plainMessages(executor.appended.at(-1) ?? [])
  const toolResult = transcript.find(message => message.role === "tool")
  const result = String(toolResult?.content[0]?.result ?? "")
  assert.match(result, /out\n/)
  assert.match(result, /err\n/)
  assert.match(result, /Exit code: 3/)
})

test("the user watches the command as it runs", async () => {
  const { handler, updates } = handlerWith({
    events: [
      { event: { case: "start", value: { sandboxPolicy: undefined } } },
      { event: { case: "stdout", value: streamEvent("out") } },
      { event: { case: "exit", value: { code: 0, aborted: false } } },
    ],
  })
  const state = stateHandler()
  await handler.handle(createContext(), shellAction("echo hi"), executorHarness().executor, state.handler, [], () => {})
  assert.equal(updates.length, 3)
})

test("a resumed turn does not show the output the user has already seen", async () => {
  const { handler, updates } = handlerWith({
    events: [
      { event: { case: "start", value: { sandboxPolicy: undefined } } },
      { event: { case: "stdout", value: streamEvent("out") } },
      { event: { case: "exit", value: { code: 0, aborted: false } } },
    ],
  })
  const state = stateHandler()
  await handler.handle(createContext(), shellAction("echo hi", "exec-1"), executorHarness().executor, state.handler, [], () => {})
  assert.deepEqual(updates, [])
})

test("a stream that breaks still leaves the output that arrived", async () => {
  const { handler } = handlerWith({
    events: [
      { event: { case: "stdout", value: streamEvent("partial") } },
      { event: { case: "exit", value: { code: 0, aborted: false } } },
    ],
    throwAfter: 1,
  })
  const state = stateHandler()
  const executor = executorHarness()
  await handler.handle(createContext(), shellAction("slow"), executor.executor, state.handler, [], () => {})

  const transcript = plainMessages(executor.appended.at(-1) ?? [])
  assert.match(String(transcript.find(message => message.role === "tool")?.content[0]?.result ?? ""), /partial/)
})

test("a command with no shell command at all is refused", async () => {
  const { handler } = handlerWith({ events: [] })
  await assert.rejects(
    () => handler.handle(createContext(), { _privacyMode: PrivacyMode.NO_STORAGE }, executorHarness().executor, stateHandler().handler, [], () => {}),
    /Shell command is required/,
  )
})

// ---------------------------------------------------------------------------------------------
// the transcript the turn is left with
// ---------------------------------------------------------------------------------------------

test("the command is written into the conversation as a turn the agent took", async () => {
  const { handler } = handlerWith({ events: [{ event: { case: "exit", value: { code: 0, aborted: false } } }] })
  const state = stateHandler()
  const executor = executorHarness()
  await handler.handle(createContext(), shellAction("ls -la"), executor.executor, state.handler, [], () => {})

  const transcript = plainMessages(executor.appended.at(-1) ?? [])
  assert.deepEqual(transcript.map(message => message.role), ["user", "assistant", "tool"])
  assert.match(String(transcript[0]?.content[0]?.text), /Run the following command: ls -la/)
  assert.equal(transcript[1]?.content[0]?.toolName, "Shell")
  assert.deepEqual(transcript[1]?.content[0]?.args, { command: "ls -la" })
  assert.equal(transcript[2]?.content[0]?.toolName, "Shell")
  // The call and the result share one id, which is what ties them together in the transcript.
  assert.equal(transcript[1]?.content[0]?.toolCallId, transcript[2]?.content[0]?.toolCallId)
  assert.equal(state.structureCalls, 1)
})

test("a large-context session writes the command the way that model expects", async () => {
  const { handler } = handlerWith({ events: [], dsv3: true })
  const state = stateHandler({ dsv3: true })
  const executor = executorHarness()
  await handler.handle(createContext(), shellAction("ls"), executor.executor, state.handler, [], () => {})

  const transcript = plainMessages(executor.appended.at(-1) ?? [])
  assert.match(String(transcript[0]?.content[0]?.text), /^<user_query>\nRun the following command: ls\n<\/user_query>$/)
  assert.equal(transcript[1]?.content[0]?.toolName, "run_terminal_cmd")
  assert.equal(transcript[2]?.content[0]?.toolName, "run_terminal_cmd")
  // That version's result repeats the command inside the output rather than only reporting the exit code.
  assert.match(String(transcript[2]?.content[0]?.result), /Command output/)
  assert.match(String(transcript[2]?.content[0]?.result), /\nls\n/)
})

test("a conversation that begins with a shell command asks for the rest of its instructions", async () => {
  const { handler, streams } = handlerWith({
    events: [],
    config: {
      systemPromptGenerator: () => "the system prompt",
      toolsGenerator: () => ({ getTool: () => undefined }),
      nonFileRules: [],
      featureFlags: {},
      userInfoDisplayOptions: { disable: true },
    },
  })
  const state = stateHandler()
  const executor = executorHarness([])
  await handler.handle(createContext(), shellAction("ls"), executor.executor, state.handler, [], () => {})

  // Seeding a transcript means reading the request context, which resolves other operations through the
  // same accessor — that is what tells the two cases apart without rebuilding the whole prompt here.
  const distinctResources = new Set(streams.resourcesAsked)
  assert.equal(distinctResources.size > 1, true)
  assert.equal(distinctResources.has(shellStreamExecutorResource), true)
})

test("a conversation that already has messages is not given its instructions again", async () => {
  const { handler, streams } = handlerWith({ events: [], config: { systemPromptGenerator: () => "the system prompt", nonFileRules: [] } })
  const state = stateHandler()
  const executor = executorHarness([{ role: "user", content: "earlier" }])
  await handler.handle(createContext(), shellAction("ls"), executor.executor, state.handler, [], () => {})

  // Only the shell stream was needed, so nothing was assembled for a first turn.
  assert.deepEqual(Array.from(new Set(streams.resourcesAsked)), [shellStreamExecutorResource])
  const written = plainMessages(executor.appended.flat())
  assert.deepEqual(written.map(message => message.role), ["user", "assistant", "tool"])
})
