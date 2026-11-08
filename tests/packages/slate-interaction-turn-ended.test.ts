import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SlateInteractionUpdates,
  slateRedactedTurnEndedUpdate,
} from "../../source/packages/agent-core/slate-interaction-updates.ts"
import {
  toRedactedInteractionListener,
  toUnredactedInteractionListener,
} from "../../source/adapters/interop/agent/redacted-interaction-listener-adapter.ts"
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

test("Slate streaming updates cross the privacy boundary and reach the run observer in order", async () => {
  const events: ForwardedUpdate[] = []
  const redactedListener = toRedactedInteractionListener(
    new InteractionUpdateForwarder(event => events.push(event)),
    PrivacyMode.NO_STORAGE,
  )
  const plainListener = toUnredactedInteractionListener(redactedListener, PrivacyMode.NO_STORAGE)

  await plainListener.sendUpdate({}, SlateInteractionUpdates.textDelta("answer"))
  await plainListener.sendUpdate({}, SlateInteractionUpdates.thinkingDelta("reasoning", 2))
  await plainListener.sendUpdate({}, SlateInteractionUpdates.tokenDelta(3))
  await plainListener.sendUpdate({}, SlateInteractionUpdates.thinkingCompleted(25))
  await plainListener.sendUpdate({}, SlateInteractionUpdates.heartbeat())

  assert.deepEqual(events, [
    { type: "text-delta", text: "answer" },
    { type: "thinking-delta", text: "reasoning" },
  ])
})
