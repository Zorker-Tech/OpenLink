import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deriveHostRunnerScope } from "../../source/host/runner/host-runner-turn-scope.ts"

describe("host runner turn scope", () => {
  it("gives a normal agent its conversation context and local permission surface", () => {
    assert.deepEqual(deriveHostRunnerScope({}), {
      groupMemberTurn: false,
      sharedRoomTurn: false,
      canAskLocalToolPermission: true,
      approvalsResolvable: true,
      hasConversationContext: true,
    })
  })

  it("removes local approval affordances from a group-member turn", () => {
    assert.deepEqual(deriveHostRunnerScope({ groupMemberTurn: true }), {
      groupMemberTurn: true,
      sharedRoomTurn: false,
      canAskLocalToolPermission: false,
      approvalsResolvable: false,
      hasConversationContext: true,
    })
  })

  it("removes private conversation state from a shared-room turn", () => {
    assert.deepEqual(deriveHostRunnerScope({ isSharedRoomTurn: true }), {
      groupMemberTurn: false,
      sharedRoomTurn: true,
      canAskLocalToolPermission: true,
      approvalsResolvable: true,
      hasConversationContext: false,
    })
  })

  it("keeps independent restrictions when both scope flags are set", () => {
    assert.deepEqual(deriveHostRunnerScope({ groupMemberTurn: true, isSharedRoomTurn: true }), {
      groupMemberTurn: true,
      sharedRoomTurn: true,
      canAskLocalToolPermission: false,
      approvalsResolvable: false,
      hasConversationContext: false,
    })
  })

  it("accepts only explicit true values as scope switches", () => {
    assert.deepEqual(deriveHostRunnerScope({ groupMemberTurn: "yes", isSharedRoomTurn: 1 }), {
      groupMemberTurn: false,
      sharedRoomTurn: false,
      canAskLocalToolPermission: true,
      approvalsResolvable: true,
      hasConversationContext: true,
    })
  })
})
