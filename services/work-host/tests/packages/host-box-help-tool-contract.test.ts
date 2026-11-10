import assert from "node:assert/strict"
import { test } from "node:test"

import {
  connectorMessageFromEmission,
  createManualHandoffTool,
  manualHandoffArguments,
  normalizeDestinationHost,
  type ManualHandoffPorts,
} from "../../source/host/runner/tools/box-help-tool.ts"
import { createContext } from "../../source/packages/context/context.ts"

type ToolResult = { toJson(): { success?: { currentStep?: string }; error?: { error?: string } } }
type ToolLike = {
  readonly name: string
  readonly toolIdentifier: string
  descriptionGenerator(): string
  execute(context: unknown, handler: unknown, args: AsyncIterable<string>, metadata: unknown): Promise<ToolResult>
}

const argsStream = async function* (value: unknown) { yield JSON.stringify(value) }

function interactionHandler(order: string[] = []) {
  return {
    async executeToolCall(
      context: unknown,
      _started: unknown,
      _callId: string,
      execute: (context: unknown) => Promise<unknown>,
      _complete: (result: unknown) => unknown,
    ) {
      order.push("execute")
      return await execute(context)
    },
  }
}

async function runTool(tool: unknown, args: unknown, handler = interactionHandler()) {
  const result = await (tool as ToolLike).execute(
    createContext(),
    handler,
    argsStream(args),
    { toolCallId: "call-1" },
  )
  return result.toJson()
}

test("box-help arguments trim the instruction and discard malformed optional metadata", () => {
  assert.deepEqual(manualHandoffArguments.parse({
    instruction: "  Approve the sign-in step  ",
    reason: "unknown-reason",
    domain: 42,
    idp_domain: "  accounts.example  ",
  }), {
    instruction: "Approve the sign-in step",
    reason: undefined,
    domain: undefined,
    idp_domain: "accounts.example",
  })
  assert.equal(manualHandoffArguments.safeParse({ instruction: "   " }).success, false)
})

test("domain normalization extracts a hostname and rejects empty or malformed destinations", () => {
  assert.equal(normalizeDestinationHost("  HTTPS://WWW.Example.com/sign-in  "), "example.com")
  assert.equal(normalizeDestinationHost("example.com/path"), "example.com")
  assert.equal(normalizeDestinationHost(""), undefined)
  assert.equal(normalizeDestinationHost("https://"), undefined)
  assert.equal(normalizeDestinationHost("%%%"), undefined)
})

test("a new handoff ends the turn, sends normalized telemetry and emits one user message", async () => {
  const order: string[] = []
  const calls: unknown[] = []
  const messages: unknown[] = []
  const dependencies: ManualHandoffPorts = {
    getAgentId: () => { order.push("agent"); return "agent-1" },
    endTurn: () => { order.push("end-turn") },
    requestHelp: async request => { order.push("request-help"); calls.push(request); return { kind: "started", requestId: "request-1" } },
    onSendMessage: (...args) => { order.push("send-message"); messages.push(args) },
    now: () => 1234,
  }
  const tool = createManualHandoffTool(dependencies)
  const result = await runTool(tool, {
    instruction: "Approve the sign-in step",
    reason: "auth",
    domain: "https://www.example.com/work",
    idp_domain: "  login.example.net  ",
  }, interactionHandler(order))

  assert.deepEqual(order, ["execute", "agent", "end-turn", "request-help", "send-message"])
  assert.deepEqual(calls, [{
    agentId: "agent-1",
    instruction: "Approve the sign-in step",
    telemetry: { reason: "auth", domain: "example.com", idpDomain: "login.example.net" },
  }])
  assert.deepEqual(messages, [[
    { type: "text", content: "Approve the sign-in step" },
    1234,
    { requestId: "request-1", instruction: "Approve the sign-in step" },
  ]])
  assert.match(result.success?.currentStep ?? "", /user now controls the box/i)
})

test("an active handoff is not duplicated and does not emit another message", async () => {
  const messages: unknown[] = []
  const dependencies: ManualHandoffPorts = {
    getAgentId: () => "agent-1",
    endTurn() {},
    requestHelp: async request => ({
      kind: "already-pending",
      requestId: "request-existing",
      instruction: request.instruction,
    }),
    onSendMessage: (...args) => { messages.push(args) },
  }
  const result = await runTool(createManualHandoffTool(dependencies), { instruction: "Confirm the payment" })

  assert.match(result.success?.currentStep ?? "", /still in progress/i)
  assert.match(result.success?.currentStep ?? "", /do not try again/i)
  assert.deepEqual(messages, [])
})

test("missing agent context fails without ending the turn or requesting a handoff", async () => {
  let ended = false
  let requested = false
  const dependencies: ManualHandoffPorts = {
    getAgentId: () => undefined,
    endTurn: () => { ended = true },
    requestHelp: async () => { requested = true; return { kind: "started", requestId: "unused" } },
    onSendMessage() {},
  }
  const result = await runTool(createManualHandoffTool(dependencies), { instruction: "Complete the step" })

  assert.equal(ended, false)
  assert.equal(requested, false)
  assert.match(result.error?.error ?? "", /Invariant violation/)
})

test("connector card emissions map to a chat message without changing their values", () => {
  assert.deepEqual(connectorMessageFromEmission({
    connector: "calendar",
    serverId: "calendar-1",
    variant: "connected",
  }), {
    type: "connector",
    connector: "calendar",
    serverId: "calendar-1",
    variant: "connected",
  })
})

test("the box-help tool keeps its stable identifier and describes a human-only step", () => {
  const dependencies: ManualHandoffPorts = {
    getAgentId: () => "agent-1",
    endTurn() {},
    requestHelp: async () => ({ kind: "started", requestId: "request-1" }),
    onSendMessage() {},
  }
  const tool = createManualHandoffTool(dependencies) as unknown as ToolLike

  assert.equal(tool.toolIdentifier, "REQUEST_BOX_HELP")
  assert.equal(tool.name, "request_box_help")
  assert.match(tool.descriptionGenerator(), /one manual step/i)
  assert.match(tool.descriptionGenerator(), /passwords or one-time codes/i)
  assert.match(tool.descriptionGenerator(), /identity provider/i)
})
