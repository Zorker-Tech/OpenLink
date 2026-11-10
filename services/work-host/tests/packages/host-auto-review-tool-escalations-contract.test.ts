import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createSlateMcpApprovalProvider,
  createSlateShellApprovalProvider,
  type McpApprovalRequest,
  type ShellApprovalRequest,
} from "../../source/host/runner/slate-auto-review-tool-escalations.ts"

test("shell escalation asks the optional pre-approval gate first, then builds the controller request", async () => {
  const calls: unknown[] = []
  const preflight: unknown[] = []
  const expiry = { until: 42 }
  const controller = { async requestApproval(request: unknown) { calls.push(request); return { approved: true } } }
  const provider = createSlateShellApprovalProvider({
    controller: controller as never,
    agentId: "agent-a",
    surface: "box_shell",
    getExpiryPolicy: () => expiry as never,
    beforeApproval: async input => { preflight.push(input); return { allowed: true } },
  })
  const abort = new AbortController()
  const request: ShellApprovalRequest = {
    target: {
      command: "git push",
      workingDirectory: "/repo",
      description: "  publish changes  ",
      blockReason: "not yet approved",
      proposedAllowRule: "git push origin",
    },
    fingerprint: "hash-1",
    toolCallId: "call-1",
    signal: abort.signal,
  }

  assert.deepEqual(await provider.requestApproval(request), { approved: true })
  assert.deepEqual(preflight, [{
    toolCallId: "call-1",
    signal: abort.signal,
    command: "git push",
    description: "publish changes",
  }])
  assert.deepEqual(calls, [{
    agentId: "agent-a",
    surface: "box_shell",
    fingerprint: "hash-1",
    reason: "not yet approved",
    summary: "publish changes in Slate's hosted workspace from /repo",
    command: "git push",
    proposedRule: "git push origin",
    signal: abort.signal,
    expiryPolicy: expiry,
  }])
})

test("a refused pre-approval returns its reason without reaching the approval controller", async () => {
  const calls: unknown[] = []
  let expiryCalls = 0
  const provider = createSlateShellApprovalProvider({
    controller: { async requestApproval(request: unknown) { calls.push(request); return { approved: true } } } as never,
    agentId: "agent-a",
    surface: "host_shell",
    getExpiryPolicy: () => { expiryCalls += 1; return {} as never },
    beforeApproval: async () => ({ allowed: false, reason: "not a writable workspace" }),
  })

  assert.deepEqual(await provider.requestApproval({
    target: { command: "write", blockReason: "blocked" },
    fingerprint: "hash-2",
    toolCallId: "call-2",
  }), { approved: false, reason: "not a writable workspace" })
  assert.deepEqual(calls, [])
  assert.equal(expiryCalls, 0)
})

test("MCP escalation uses the MCP surface and leaves absent optional fields out", async () => {
  const calls: Record<string, unknown>[] = []
  const expiry = { durationMs: 1_000 }
  const abort = new AbortController()
  const provider = createSlateMcpApprovalProvider({
    controller: { async requestApproval(request: Record<string, unknown>) { calls.push(request); return { approved: true } } } as never,
    agentId: "agent-b",
    getExpiryPolicy: () => expiry as never,
  })
  const request: McpApprovalRequest = {
    kind: "mcp",
    fingerprint: "mcp-hash",
    toolCallId: "mcp-call-1",
    conversationId: "conversation-1",
    signal: abort.signal,
    target: {
      blockReason: "tool needs approval",
      serverIdentifier: "calendar-service",
      serverName: "calendar",
      toolName: "delete_event",
      mcpMode: "file_system",
      mcpArguments: { eventId: "event-1" },
      description: "  remove an event  ",
    },
  }

  assert.deepEqual(await provider.requestApproval(request), { approved: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.agentId, "agent-b")
  assert.equal(calls[0]?.surface, "mcp")
  assert.equal(calls[0]?.fingerprint, "mcp-hash")
  assert.equal(calls[0]?.reason, "tool needs approval")
  assert.equal(calls[0]?.expiryPolicy, expiry)
  assert.equal(calls[0]?.command, "Run delete_event via calendar with {\"eventId\":\"event-1\"}")
  assert.equal(calls[0]?.signal, abort.signal)
  assert.equal("proposedRule" in (calls[0] ?? {}), false)
  assert.match(String(calls[0]?.summary), /remove an event/)
})
