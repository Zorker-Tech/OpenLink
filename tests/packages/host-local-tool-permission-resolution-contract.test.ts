import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isSlateLocalToolPermissionResolution,
  resolveLocalToolPermissionAsk,
  type LocalToolPermissionResolutionArgs,
  type LocalToolPermissionTranscript,
} from "../../source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts"
import type { SlateLocalToolPermissionController } from "../../source/host/extensions/local-tool-permission/local-tool-permission-controller.ts"

interface HarnessOptions {
  readonly pendingAgentId?: string | undefined
  readonly wasSettled?: boolean | undefined
  readonly retirement?: boolean | "retired" | undefined
  readonly resolveResult?: boolean | undefined
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<[string, unknown]> = []
  const asks = {
    getPendingRequestById(requestId: string) {
      calls.push(["pending", requestId])
      return options.pendingAgentId === undefined ? undefined : { agentId: options.pendingAgentId }
    },
    wasSettled(requestId: string) {
      calls.push(["settled", requestId])
      return options.wasSettled === true
    },
    resolveRequest(requestId: string, resolution: unknown) {
      calls.push(["resolve", { requestId, resolution }])
      return options.resolveResult === false ? undefined : { requestId }
    },
  } as unknown as SlateLocalToolPermissionController
  const transcript: LocalToolPermissionTranscript = {
    widgetResponses: {
      async settleStaleLocalToolPermissionCard(args) {
        calls.push(["retire", args])
        return options.retirement ?? false
      },
      async expireAllPendingLocalToolPermissionCards() {},
    },
  }
  let stranded = 0
  return {
    calls,
    deps: { asks, transcript, onStrandedRetirement: () => stranded++ },
    stranded: () => stranded,
  }
}

const request = (overrides: Partial<LocalToolPermissionResolutionArgs> = {}): LocalToolPermissionResolutionArgs => ({
  agentId: "agent-a",
  entryId: "entry-a",
  requestId: "request-a",
  resolution: "deny",
  ...overrides,
})

test("only the four declared choices are valid resolutions", () => {
  for (const choice of ["allow-once", "deny", "always", "never"]) {
    assert.equal(isSlateLocalToolPermissionResolution(choice), true)
  }
  for (const choice of ["ALLOW-ONCE", "allow_once", "", "constructor", null, undefined, 1]) {
    assert.equal(isSlateLocalToolPermissionResolution(choice), false)
  }
})

test("a live request is resolved only for the agent that owns it", async () => {
  const current = harness({ pendingAgentId: "agent-a" })
  await resolveLocalToolPermissionAsk(current.deps, request({ resolution: "allow-once" }))
  assert.deepEqual(current.calls, [
    ["pending", "request-a"],
    ["resolve", { requestId: "request-a", resolution: "allow-once" }],
  ])

  const foreign = harness({ pendingAgentId: "agent-b" })
  await assert.rejects(resolveLocalToolPermissionAsk(foreign.deps, request()), /no longer waiting for an answer/)
  assert.deepEqual(foreign.calls, [["pending", "request-a"]])
})

test("invalid and already-settled requests never reach transcript cleanup", async () => {
  const invalid = harness({ retirement: "retired" })
  await assert.rejects(
    resolveLocalToolPermissionAsk(invalid.deps, request({ resolution: "maybe" })),
    /Unknown local-tool permission resolution/,
  )
  assert.deepEqual(invalid.calls, [])

  const settled = harness({ wasSettled: true })
  await resolveLocalToolPermissionAsk(settled.deps, request())
  assert.deepEqual(settled.calls, [["pending", "request-a"], ["settled", "request-a"]])
})

test("a stale card is retired before returning, with a callback only for retirement", async () => {
  const stillPresent = harness({ retirement: true })
  await resolveLocalToolPermissionAsk(stillPresent.deps, request())
  assert.equal(stillPresent.calls[2]?.[0], "retire")
  assert.equal(stillPresent.stranded(), 0)

  const retired = harness({ retirement: "retired" })
  await resolveLocalToolPermissionAsk(retired.deps, request())
  assert.equal(retired.stranded(), 1)

  const notSettled = harness({ retirement: false })
  await assert.rejects(resolveLocalToolPermissionAsk(notSettled.deps, request()), /no longer waiting for an answer/)
  assert.equal(notSettled.stranded(), 0)
})

test("a request that races with settlement reports the stale-answer error", async () => {
  const current = harness({ pendingAgentId: "agent-a", resolveResult: false })
  await assert.rejects(resolveLocalToolPermissionAsk(current.deps, request()), /no longer waiting for an answer/)
  assert.deepEqual(current.calls, [
    ["pending", "request-a"],
    ["resolve", { requestId: "request-a", resolution: "deny" }],
  ])
})
