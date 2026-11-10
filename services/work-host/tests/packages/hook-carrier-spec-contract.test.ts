import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT } from "../../source/packages/hooks/hook-registry.ts"
import { HOOK_STEP_CARRIER_SPECS } from "../../source/packages/hooks-carriers/carrier-spec.ts"

describe("hook carrier spec", () => {
  it("has exactly one Slate carrier entry for each context-bearing hook step", () => {
    const entries = Object.entries(HOOK_STEP_CARRIER_SPECS)
    assert.deepEqual(entries.map(([step]) => step).sort(), [...HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT].sort())
    for (const [step, spec] of entries) assert.deepEqual(spec, { event: step })
  })
})
