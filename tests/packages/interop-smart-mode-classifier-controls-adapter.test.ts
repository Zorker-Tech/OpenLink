import assert from "node:assert/strict"
import test from "node:test"
import { RequestContext, RequestContextEnv } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"
import { smartModeClassifierControlsFromRequestContext } from "../../source/adapters/interop/agent/smart-mode-classifier-controls-adapter.ts"

test("classifier controls map from the external request environment", () => {
  const context = new RequestContext({
    env: new RequestContextEnv({
      smartModeClassifierAutoModeEnabled: true,
      devForceNextSmartModeClassifierBlockToken: "block-next",
      devDelayNextSmartModeClassifierToken: "delay-next",
    }),
  })

  assert.deepEqual(smartModeClassifierControlsFromRequestContext(context, { development: true }), {
    automaticModeEnabled: true,
    blockNextToken: "block-next",
    delayNextToken: "delay-next",
  })
})

test("production controls ignore one-shot development values but retain the mode setting", () => {
  const context = new RequestContext({
    env: new RequestContextEnv({
      smartModeClassifierAutoModeEnabled: true,
      devForceNextSmartModeClassifierBlockToken: "block-next",
      devDelayNextSmartModeClassifierToken: "delay-next",
    }),
  })

  assert.deepEqual(smartModeClassifierControlsFromRequestContext(context, { development: false }), {
    automaticModeEnabled: true,
  })
})

test("a missing request environment defaults to an inactive classifier setting", () => {
  assert.deepEqual(smartModeClassifierControlsFromRequestContext(undefined), {
    automaticModeEnabled: false,
  })
})
