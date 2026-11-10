import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createSlateSubagentType,
  isComputerUseSubagentType,
  isCustomSubagentType,
  isVideoReviewSubagentType,
  slateSubagentTypeName,
} from "../../source/packages/agent/subagent-type.ts"

describe("Slate subagent types", () => {
  it("projects every supported kind into the product vocabulary", () => {
    assert.equal(slateSubagentTypeName(createSlateSubagentType("general-purpose")), "generalPurpose")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("computer-use")), "computerUse")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("explore")), "explore")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("shell")), "shell")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("browser-use")), "browser-use")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("debug")), "debug")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("guide")), "cursor-guide")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("video-review")), "videoReview")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("watch-video")), "watchVideo")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("environment-setup")), "vmSetupHelper")
  })

  it("keeps custom names and handles missing or future kinds explicitly", () => {
    const custom = createSlateSubagentType("custom", { customName: "releaseBot" })
    assert.equal(isCustomSubagentType(custom), true)
    assert.equal(slateSubagentTypeName(custom), "releaseBot")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("custom")), "unknown")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("unknown")), "unknown")
    assert.equal(slateSubagentTypeName(createSlateSubagentType("future-product-kind")), "future-product-kind")
  })

  it("recognizes only the two video review surfaces", () => {
    assert.equal(isVideoReviewSubagentType(createSlateSubagentType("video-review")), true)
    assert.equal(isVideoReviewSubagentType(createSlateSubagentType("watch-video")), true)
    assert.equal(isVideoReviewSubagentType(createSlateSubagentType("explore")), false)
    assert.equal(isVideoReviewSubagentType(undefined), false)
  })

  it("recognizes the desktop-driving kind by its Slate value", () => {
    assert.equal(isComputerUseSubagentType(createSlateSubagentType("computer-use")), true)
    assert.equal(isComputerUseSubagentType(createSlateSubagentType("browser-use")), false)
  })
})
