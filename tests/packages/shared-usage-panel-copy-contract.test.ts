import assert from "node:assert/strict"
import { test } from "node:test"

import { USAGE_PANEL_COPY } from "../../source/packages/constants/usage-copy.ts"

test("the usage panel keeps its Slate-owned labels and explanations together", () => {
  assert.deepEqual(USAGE_PANEL_COPY, {
    includedTitle: "Included models",
    includedDescription: "Covered by the usage your plan includes.",
    otherTitle: "Other models",
    otherDescription: "Consumed by named models.",
    beyondLimitDescription: "Additional usage beyond your limits consumes other-model quota or on-demand spend.",
    includedUsageBarLabel: "your included total usage",
    otherUsageBarLabel: "your included API usage",
  })
})
