import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BoxStoreSyncError,
  isBoxStoreSyncError,
} from "../../source/host/boxes/box-store-sync/box-store-sync-error.ts"

describe("box store sync failures", () => {
  it("keeps the native error details and names subclasses by their own type", () => {
    const cause = new Error("transport closed")
    const failure = new BoxStoreSyncError("store write failed", { cause })

    assert.ok(failure instanceof Error)
    assert.equal(failure.name, "BoxStoreSyncError")
    assert.equal(failure.message, "store write failed")
    assert.equal(failure.cause, cause)
    assert.equal(isBoxStoreSyncError(failure), true)
    assert.equal(isBoxStoreSyncError(new Error("unrelated")), false)

    class SpecializedFailure extends BoxStoreSyncError {}
    assert.equal(new SpecializedFailure("specialized").name, "SpecializedFailure")
  })
})
