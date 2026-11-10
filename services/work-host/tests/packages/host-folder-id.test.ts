import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSafeFolderId } from "../../source/host/storage/folder-id.ts";

describe("folder component ids", () => {
  it("accepts non-empty single path components without normalizing them", () => {
    for (const id of ["a", "a b", " a ", "...", "雪", "0"]) {
      assert.equal(isSafeFolderId(id), true, JSON.stringify(id));
    }
  });

  it("refuses absent, non-string, empty, separator and traversal values", () => {
    for (const id of [undefined, null, 0, {}, [], "", "/", "\\", "\0", "../child", "parent/child", "parent\\child", "a\0b", ".", ".."] as unknown[]) {
      assert.equal(isSafeFolderId(id), false, String(id));
    }
  });

  it("narrows accepted values to strings", () => {
    const value: unknown = "agent-id";
    if (isSafeFolderId(value)) assert.equal(value.toUpperCase(), "AGENT-ID");
    else assert.fail("valid folder id was not narrowed");
  });
});
