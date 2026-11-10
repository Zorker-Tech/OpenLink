import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  CAP_SLACK_MS,
  createTeachRecordingExtension,
  loadTeachQueueKey,
  parseTeachQueueKey,
  TEACH_QUEUE_KEY_FILENAME,
  type TeachRecordingExtensionContext,
} from "../../source/host/extensions/teach-recording/extension.ts"
import { createTeachRecordingService, LEARN_SKILL_NAME, type TeachRecordingDeps } from "../../source/host/extensions/teach-recording/teach-recording-service.ts"
import { SLATE_TEACH_MAX_DURATION_MS } from "../../source/shared/agents/teach-recording.ts"
import type { HostBox } from "../../source/host/boxes/forever-box/host-box.ts"

test("the queue key parser accepts only version-one lowercase SHA-256 keys", () => {
  const keyHex = "a".repeat(64)
  assert.deepEqual(parseTeachQueueKey(JSON.stringify({ version: 1, keyHex })), Buffer.from(keyHex, "hex"))
  assert.equal(parseTeachQueueKey(JSON.stringify({ version: 2, keyHex })), null)
  assert.equal(parseTeachQueueKey(JSON.stringify({ version: 1, keyHex: keyHex.toUpperCase() })), null)
  assert.equal(parseTeachQueueKey(JSON.stringify({ version: 1, keyHex: "short" })), null)
  assert.equal(parseTeachQueueKey("broken"), null)
})

test("the queue key is persisted privately, reused, and replaced if its saved form is invalid", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-teach-queue-key-"))
  try {
    const first = await loadTeachQueueKey(root)
    const path = join(root, TEACH_QUEUE_KEY_FILENAME)
    assert.equal(first.byteLength, 32)
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, keyHex: first.toString("hex") })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(await loadTeachQueueKey(root), first)

    writeFileSync(path, JSON.stringify({ version: 1, keyHex: "bad" }))
    const replacement = await loadTeachQueueKey(root)
    assert.equal(replacement.byteLength, 32)
    assert.notDeepEqual(replacement, first)
    assert.deepEqual(parseTeachQueueKey(readFileSync(path, "utf8")), replacement)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

type TeachRecordingService = ReturnType<typeof createTeachRecordingService>

function extensionContext(order: string[]) {
  const analytics: Array<[string, Record<string, unknown>]> = []
  const reports: Array<[string, Record<string, unknown>]> = []
  const sendCalls: Array<[string, string, Record<string, unknown>]> = []
  const authGateCalls: string[] = []
  let stop: (() => Promise<void>) | undefined
  const context: TeachRecordingExtensionContext = {
    deps: {
      experiments: { checkFeatureGate(name) { authGateCalls.push(name); return true } },
      "forever-box": { box: { boxId: "box-a" } as unknown as HostBox },
      "managed-setup": { ensureManagedSkill: async id => id === LEARN_SKILL_NAME },
      transcript: {
        sendPrompt: async (content, opts) => { sendCalls.push(["agent-a", content, opts]) },
        listAgentIds: async () => ["agent-a"],
      },
      telemetry: {
        analytics: { trackEvent(name, event) { analytics.push([name, event]) } },
        logs: {
          reportTeachRecordingCapStopFailed(event) { reports.push(["cap-stop", event]) },
          reportTeachRecordingStartFailed(event) { reports.push(["start", event]) },
        },
      },
    },
    onStop(fn) { order.push("register-stop"); stop = fn },
    host: { log(message) { order.push(`log:${message}`) } },
  }
  return { context, analytics, reports, sendCalls, authGateCalls, stop: () => stop }
}

test("the extension wires the host ports into the recording service and disposes it after recovery", async () => {
  const order: string[] = []
  const api = { marker: "recording-api" }
  const service = {
    api,
    async recoverPending() { order.push("recover") },
    async dispose() { order.push("dispose") },
  } as unknown as TeachRecordingService
  let captured: TeachRecordingDeps | undefined
  const harness = extensionContext(order)
  const extension = createTeachRecordingExtension(((deps: TeachRecordingDeps) => {
    captured = deps
    order.push("create")
    return service
  }) as never)

  assert.equal(await extension.start(harness.context), api)
  assert.deepEqual(order, ["create", "recover", "register-stop"])
  assert.equal(captured?.isEnabled(), true)
  assert.deepEqual(harness.authGateCalls, ["slate_teach_by_demonstration"])
  assert.deepEqual(await captured?.listAgentIds(), ["agent-a"])
  assert.equal(await captured?.ensureLearningWorkflow(), true)
  assert.equal(CAP_SLACK_MS, 2_000)
  assert.equal(SLATE_TEACH_MAX_DURATION_MS > 0, true)

  await captured?.sendLearningPrompt("agent-a", { content: "learn", richText: "rich", clientNonce: "nonce" })
  assert.deepEqual(harness.sendCalls, [["agent-a", "learn", {
    agentId: "agent-a",
    clientNonce: "nonce",
    directAddressedAcceptance: true,
    awaitTurn: false,
    richText: "rich",
  }]])
  captured?.trackRecordingStarted({ agentId: "agent-a" })
  captured?.trackRecordingStopped({ agentId: "agent-a" })
  captured?.reportStartFailed({ reason: "start" })
  captured?.reportCapStopFailed({ reason: "stop" })
  assert.deepEqual(harness.analytics.map(([name]) => name), ["slate.teach.recording_started", "slate.teach.recording_stopped"])
  assert.deepEqual(harness.reports.map(([kind]) => kind), ["start", "cap-stop"])

  await harness.stop()?.()
  assert.equal(order.at(-1), "dispose")
})

test("pending recovery failure is logged without preventing extension startup", async () => {
  const order: string[] = []
  const service = {
    api: { marker: true },
    async recoverPending() { throw new Error("queue unavailable") },
    async dispose() {},
  } as unknown as TeachRecordingService
  const harness = extensionContext(order)
  const extension = createTeachRecordingExtension((() => service) as never)

  assert.deepEqual(await extension.start(harness.context), { marker: true })
  assert.equal(order.includes("log:teach-recording: pending delivery recovery failed"), true)
  assert.equal(typeof harness.stop(), "function")
})
