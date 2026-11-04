import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isCustomSubagentType,
  isVideoReviewSubagentType,
  slateSubagentTypeName,
} from "../../source/packages/agent/subagent-type.ts"

const typeOf = (kind: string | undefined, value?: unknown) => ({ type: { case: kind, value } })

describe("Slate subagent types", () => {
  it("projects every supported kind into the product vocabulary", () => {
    assert.equal(slateSubagentTypeName(typeOf("unspecified")), "generalPurpose")
    assert.equal(slateSubagentTypeName(typeOf("computerUse")), "computerUse")
    assert.equal(slateSubagentTypeName(typeOf("explore")), "explore")
    assert.equal(slateSubagentTypeName(typeOf("bash")), "shell")
    assert.equal(slateSubagentTypeName(typeOf("shell")), "shell")
    assert.equal(slateSubagentTypeName(typeOf("browserUse")), "browser-use")
    assert.equal(slateSubagentTypeName(typeOf("debug")), "debug")
    assert.equal(slateSubagentTypeName(typeOf("cursorGuide")), "cursor-guide")
    assert.equal(slateSubagentTypeName(typeOf("mediaReview")), "videoReview")
    assert.equal(slateSubagentTypeName(typeOf("watchVideo")), "watchVideo")
  })

  it("keeps custom names and handles missing or future kinds explicitly", () => {
    const custom = typeOf("custom", { name: "releaseBot" })
    assert.equal(isCustomSubagentType(custom), true)
    assert.equal(slateSubagentTypeName(custom), "releaseBot")
    assert.equal(slateSubagentTypeName(typeOf("custom", {})), "unknown")
    assert.equal(slateSubagentTypeName(typeOf(undefined)), "unknown")
    assert.equal(slateSubagentTypeName(typeOf("futureType")), "futureType")
  })

  it("recognizes only the two video review surfaces", () => {
    assert.equal(isVideoReviewSubagentType(typeOf("mediaReview")), true)
    assert.equal(isVideoReviewSubagentType(typeOf("watchVideo")), true)
    assert.equal(isVideoReviewSubagentType(typeOf("explore")), false)
    assert.equal(isVideoReviewSubagentType(undefined), false)
  })
})
