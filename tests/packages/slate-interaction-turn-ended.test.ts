import assert from "node:assert/strict"
import { test } from "node:test"

import { slateRedactedTurnEndedUpdate } from "../../source/packages/agent-core/slate-interaction-updates.ts"
import { toRedactedInteractionListener } from "../../source/adapters/interop/agent/redacted-interaction-listener-adapter.ts"
import { InteractionUpdateForwarder, type ForwardedUpdate } from "../../source/host/runner/forwarding-interaction-updates.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

test("a Slate turn-ended event reaches the local run observer without a generated message envelope", async () => {
  const events: ForwardedUpdate[] = []
  const forwarder = new InteractionUpdateForwarder(event => events.push(event))
  const redactedListener = toRedactedInteractionListener(forwarder, PrivacyMode.NO_STORAGE)

  await redactedListener.sendUpdate({}, slateRedactedTurnEndedUpdate(PrivacyMode.NO_STORAGE, {
    inputTokens: 12,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
  }))

  assert.deepEqual(events, [{
    type: "turn-ended",
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 0,
    },
  }])
})

test("a Slate turn-ended event without counts stays empty through the local listener", async () => {
  const events: ForwardedUpdate[] = []
  const redactedListener = toRedactedInteractionListener(
    new InteractionUpdateForwarder(event => events.push(event)),
    PrivacyMode.NO_STORAGE,
  )

  await redactedListener.sendUpdate({}, slateRedactedTurnEndedUpdate(PrivacyMode.NO_STORAGE))

  assert.deepEqual(events, [{ type: "turn-ended" }])
})
