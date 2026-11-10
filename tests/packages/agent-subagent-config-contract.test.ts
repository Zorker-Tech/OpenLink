import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  SubagentType,
  SubagentTypeBash,
  SubagentTypeCustom,
  SubagentTypeMediaReview,
  SubagentTypeShell,
  SubagentTypeUnspecified,
  SubagentTypeWatchVideo,
} from "../../source/adapters/interop/proto/generated/agent/v1/subagents_pb.ts"
import {
  GENERAL_PURPOSE_SUBAGENT_TYPE,
  normalizeSubagentTypeName,
} from "../../source/packages/agent/tools/core/subagent/subagent-config.ts"
import {
  isVideoReviewSubagentType,
  mapSubagentConversationState,
  slateSubagentConfigFromInterop,
  slateSubagentTypeFromInterop,
  subagentTypeNameFromInterop,
  subagentTypeToInterop,
} from "../../source/adapters/interop/agent/subagent-type-adapter.ts"
import { SlateSubagentKind, slateSubagentTypeName } from "../../source/packages/agent/subagent-type.ts"

describe("subagent type and state boundary", () => {
  it("normalizes casing and separators, removes one type suffix, and keeps the old media alias searchable", () => {
    assert.equal(normalizeSubagentTypeName(GENERAL_PURPOSE_SUBAGENT_TYPE), "generalpurpose")
    assert.equal(normalizeSubagentTypeName(" General-Purpose-Subagent_Type "), "generalpurpose")
    assert.equal(normalizeSubagentTypeName("ExploreSubagentType"), "explore")
    assert.equal(normalizeSubagentTypeName("MediaReview"), "videoreview")
  })

  it("projects the generated type union to Slate names at the interop boundary", () => {
    const cases: Array<[SubagentType, string]> = [
      [new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified() } }), GENERAL_PURPOSE_SUBAGENT_TYPE],
      [new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "release-helper" }) } }), "release-helper"],
      [new SubagentType({ type: { case: "bash", value: new SubagentTypeBash() } }), "shell"],
      [new SubagentType({ type: { case: "shell", value: new SubagentTypeShell() } }), "shell"],
      [new SubagentType({ type: { case: "mediaReview", value: new SubagentTypeMediaReview() } }), "videoReview"],
      [new SubagentType({ type: { case: "watchVideo", value: new SubagentTypeWatchVideo() } }), "watchVideo"],
      [new SubagentType(), "unknown"],
    ]

    for (const [value, expected] of cases) assert.equal(subagentTypeNameFromInterop(value), expected)
    assert.equal(isVideoReviewSubagentType(cases[4]![0]), true)
    assert.equal(isVideoReviewSubagentType(cases[5]![0]), true)
    assert.equal(isVideoReviewSubagentType(cases[2]![0]), false)
    assert.equal(isVideoReviewSubagentType(undefined), false)
  })

  it("maps generated oneofs into Slate values and projects them back at the runner edge", () => {
    const source = new SubagentType({ type: { case: "custom", value: new SubagentTypeCustom({ name: "release-helper" }) } })
    const slate = slateSubagentTypeFromInterop(source)
    assert.deepEqual(slate, {
      kind: SlateSubagentKind.CUSTOM,
      customName: "release-helper",
    })
    assert.equal(SubagentType.equals(subagentTypeToInterop(slate), source), true)

    const slateConfig = slateSubagentConfigFromInterop({ subagent_type: source, description: "release tools" }) as {
      readonly subagentType: typeof slate
      readonly description: string
    }
    assert.deepEqual(slateConfig, { subagentType: slate, description: "release tools" })
    assert.equal("subagent_type" in slateConfig, false)
  })

  it("keeps Slate built-ins on the same runner aliases", () => {
    const computerUse = subagentTypeToInterop({ kind: SlateSubagentKind.COMPUTER_USE })
    const browserUse = subagentTypeToInterop({ kind: SlateSubagentKind.BROWSER_USE })
    assert.equal(computerUse?.type.case, "computerUse")
    assert.equal(browserUse?.type.case, "browserUse")
    assert.equal(slateSubagentTypeName({ kind: SlateSubagentKind.BROWSER_USE }), "browser-use")
  })

  it("starts with a fresh empty conversation state unless a mapper is explicitly supplied", () => {
    const caller = new ConversationStateStructure({ turns: [new Uint8Array([1])] })
    const fresh = mapSubagentConversationState({}, caller)
    assert.notEqual(fresh, caller)
    assert.deepEqual(fresh.turns, [])
    assert.deepEqual(caller.turns, [new Uint8Array([1])])

    const mapped = new ConversationStateStructure({ turns: [new Uint8Array([2])] })
    let received: ConversationStateStructure | undefined
    assert.equal(mapSubagentConversationState({
      conversationStateMapper: state => { received = state; return mapped },
    }, caller), mapped)
    assert.equal(received, caller)
  })
})
