import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isAgentStoreId,
  isAgentStoreShareMountKey,
  isAgentStoreSourceId,
  isCloudAgentStoreId,
  isValidBareUuid,
  parseTeamAgentStoreSourceId,
  parseUserAgentStoreSourceId,
} from "../../source/packages/agent-store-sync/identifiers.ts"

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

test("service source identifiers project to owner values or fail closed", () => {
  assert.deepEqual(parseUserAgentStoreSourceId("u42"), { userId: 42 })
  assert.deepEqual(parseUserAgentStoreSourceId("t7-u42"), { userId: 42, teamId: 7 })
  assert.deepEqual(parseTeamAgentStoreSourceId("t7"), { teamId: 7 })
  assert.equal(parseTeamAgentStoreSourceId("t0"), undefined)
  assert.equal(parseTeamAgentStoreSourceId("u7"), undefined)

  for (const invalid of [
    "u0", "u-1", "u1.5", "t0-u1", "t-u1", "u", "", "U42", "u42x", "x42",
    "u9007199254740992", "t9007199254740992-u1",
  ]) {
    assert.equal(parseUserAgentStoreSourceId(invalid), undefined, invalid)
  }
})

test("store, cloud-source and local-source identifiers are recognized by their external shapes", () => {
  assert.equal(isValidBareUuid(UUID), true)
  assert.equal(isValidBareUuid("not-a-uuid"), false)
  assert.equal(isAgentStoreId("store-" + UUID), true)
  assert.equal(isAgentStoreId(UUID), false)
  assert.equal(isCloudAgentStoreId("bc-team-" + UUID), true)
  assert.equal(isCloudAgentStoreId("bc-" + UUID), true)
  assert.equal(isCloudAgentStoreId(UUID), false)
  assert.equal(isAgentStoreSourceId(UUID), true)
  assert.equal(isAgentStoreSourceId("bc-" + UUID), true)
  assert.equal(isAgentStoreSourceId("store-" + UUID), false)
})

test("shared mount keys use the service's fixed opaque token size", () => {
  assert.equal(isAgentStoreShareMountKey("store-" + "a".repeat(24)), true)
  assert.equal(isAgentStoreShareMountKey("store-" + "a".repeat(23)), false)
  assert.equal(isAgentStoreShareMountKey("store-" + "a".repeat(25)), false)
  assert.equal(isAgentStoreShareMountKey("STORE-" + "a".repeat(24)), false)
})
