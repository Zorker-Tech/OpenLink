import assert from "node:assert/strict"
import { test } from "node:test"

import { ClientSideToolV2Call, ClientSideToolV2Result } from "../../source/adapters/interop/proto/generated/aiserver/v1/tools_pb.ts"
import {
  CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT,
  CLIENT_SIDE_TOOL_V2_FAMILY,
  decodeClientSideToolV2Message,
} from "../../source/adapters/interop/agent/client-side-tool-v2-transport-adapter.ts"
import { ClientSideToolV2Producer } from "../../source/adapters/interop/agent/client-side-tool-v2-producer-adapter.ts"
import { ClientSideToolV2Relay } from "../../source/adapters/interop/agent/client-side-tool-v2-relay-adapter.ts"

const call = (id: string) => new ClientSideToolV2Call({ toolCallId: id, name: "ReadFile", rawArgs: "{}" })
const result = (id: string) => new ClientSideToolV2Result({ toolCallId: id })

test("the wire producer pairs results with open calls and advances each agent sequence", () => {
  const producer = new ClientSideToolV2Producer("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
  assert.equal(producer.publish("agent-1", { kind: "result", value: result("orphan") }), null)

  const first = producer.publish("agent-1", { kind: "call", value: call("call-1") })
  const second = producer.publish("agent-1", { kind: "result", value: result("call-1") })
  const other = producer.publish("agent-2", { kind: "call", value: call("call-2") })
  assert.deepEqual([first?.sequence, second?.sequence, other?.sequence], [1, 2, 1])
  assert.equal(first?.accountSlot, CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT)
  assert.equal(first?.kind, "call")
  assert.equal(first?.kind === "call" ? decodeClientSideToolV2Message("call", first.message)?.toolCallId : undefined, "call-1")
  assert.equal(second?.kind === "result" ? decodeClientSideToolV2Message("result", second.message)?.toolCallId : undefined, "call-1")
  assert.equal(producer.publish("agent-1", { kind: "result", value: result("call-1") }), null)

  const reset = producer.reset("agent-1")
  assert.equal(reset?.sequence, 3)
  assert.equal(reset?.kind, "reset")
  assert.equal(producer.publish("agent-1", { kind: "result", value: result("call-1") }), null)
})

test("the relay fences stale sequences and epochs, then replays only the active call lifecycle", () => {
  const posted: Array<{ family: string; payload: unknown }> = []
  const relay = new ClientSideToolV2Relay((family, payload) => posted.push({ family, payload }))
  const earlier = new ClientSideToolV2Producer("11111111-1111-4111-8111-111111111111")
  const oldCall = earlier.publish("agent-1", { kind: "call", value: call("old-call") })!
  const oldResult = earlier.publish("agent-1", { kind: "result", value: result("old-call") })!

  assert.equal(relay.accept({ ...oldCall, accountSlot: "other-slot" }), false)
  assert.equal(relay.accept(oldCall), true)
  assert.equal(relay.accept(oldCall), false)
  assert.equal(relay.accept(oldResult), true)

  const current = new ClientSideToolV2Producer("22222222-2222-4222-8222-222222222222")
  const currentCall = current.publish("agent-1", { kind: "call", value: call("new-call") })!
  const currentResult = current.publish("agent-1", { kind: "result", value: result("new-call") })!
  assert.equal(relay.accept(currentCall), true)
  assert.equal(relay.accept(currentResult), true)
  assert.equal(relay.accept(earlier.reset("agent-1")), false)

  const beforeReplay = posted.length
  relay.replay()
  const replayed = posted.slice(beforeReplay)
  assert.deepEqual(replayed.map((entry) => entry.family), [CLIENT_SIDE_TOOL_V2_FAMILY, CLIENT_SIDE_TOOL_V2_FAMILY])
  assert.deepEqual(replayed.map((entry) => (entry.payload as { kind: string }).kind), ["call", "result"])
  assert.deepEqual(replayed.map((entry) => ((entry.payload as { message: { encoding: string; bytes: Uint8Array } }).message.encoding)), ["protobuf", "protobuf"])

  const reset = current.reset("agent-1")!
  assert.equal(relay.accept(reset), true)
  assert.equal((posted.at(-1)?.payload as { kind: string }).kind, "reset")
  const afterReset = posted.length
  relay.replay()
  assert.equal(posted.length, afterReset)

  relay.clear()
  const afterClear = posted.length
  relay.replay()
  assert.equal(posted.length, afterClear)
})
