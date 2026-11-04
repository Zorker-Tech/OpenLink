import assert from "node:assert/strict"
import { describe, it } from "node:test"

import * as slateHookConfigTypes from "../../source/packages/hooks/foreign-hook-config.ts"
import { transformForeignHookConfig } from "../../source/adapters/interop/hooks/foreign-hook-config-adapter.ts"

describe("foreign hook config boundary", () => {
  it("keeps source dialect parsing out of the Slate-owned hook package surface", () => {
    assert.equal("transformForeignHookConfig" in slateHookConfigTypes, false)
    assert.equal("detectHookConfigDialect" in slateHookConfigTypes, false)
    assert.equal("HOOK_STEP_TO_EVENT" in slateHookConfigTypes, false)
  })

  it("projects a foreign event into the Slate hook config shape at interop", () => {
    assert.deepEqual(transformForeignHookConfig({ Stop: [{ hooks: [{ command: "stop.sh" }] }] }), {
      version: 1,
      hooks: {
        stop: [{
          type: "command",
          command: "stop.sh",
          loop_limit: null,
          failClosed: false,
        }],
      },
    })
  })
})
