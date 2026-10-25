import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoxStoreCanonicalWriteConflictError } from "../../source/host/boxes/box-store-sync/object-store-port.ts";

describe("a lost box-store write race", () => {
  it("carries the canonical key and null defaults when no conflict copy exists", () => {
    const error = new BoxStoreCanonicalWriteConflictError({ key: "manifest.json" });
    assert.equal(error instanceof Error, true);
    assert.equal(error instanceof TypeError, false);
    assert.equal(error.name, "BoxStoreCanonicalWriteConflictError");
    assert.equal(error.message, "canonical write for manifest.json lost a concurrent-write race");
    assert.deepEqual([error.key, error.conflictRelPath, error.baseEtag, error.baselineSource], ["manifest.json", null, null, null]);
  });

  it("points at preserved conflict content and retains the write baseline", () => {
    const error = new BoxStoreCanonicalWriteConflictError({
      key: "agent.json",
      conflictRelPath: "agent.json.conflict-2",
      baseEtag: "etag-7",
      baselineSource: "session",
    });
    assert.equal(error.message, "agent-store write for agent.json lost a concurrent-write race; content preserved at agent.json.conflict-2");
    assert.deepEqual([error.key, error.conflictRelPath, error.baseEtag, error.baselineSource], ["agent.json", "agent.json.conflict-2", "etag-7", "session"]);
  });

  it("preserves explicit null and empty string values", () => {
    const explicitNull = new BoxStoreCanonicalWriteConflictError({ key: "null.json", conflictRelPath: null, baseEtag: null, baselineSource: null });
    assert.equal(explicitNull.message, "canonical write for null.json lost a concurrent-write race");
    assert.deepEqual([explicitNull.conflictRelPath, explicitNull.baseEtag, explicitNull.baselineSource], [null, null, null]);

    const empty = new BoxStoreCanonicalWriteConflictError({ key: "", conflictRelPath: "", baseEtag: "", baselineSource: "" });
    assert.equal(empty.message, "agent-store write for  lost a concurrent-write race; content preserved at ");
    assert.deepEqual([empty.key, empty.conflictRelPath, empty.baseEtag, empty.baselineSource], ["", "", "", ""]);
  });
});
