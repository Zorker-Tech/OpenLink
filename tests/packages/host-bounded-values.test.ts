import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_ERRNO_FALLBACK,
  SLATE_ERRNO_TAGS,
  brandLiteralEnum,
  brandedEnumOf,
  brandedErrno,
  brandedId,
} from "../../source/shared/errors/bounded-values.ts";

describe("a value admitted only when it is one we know", () => {
  it("admits what it was given, and reports anything else as the fallback", () => {
    const admit = brandedEnumOf(["a", "b"] as const, "other");
    assert.equal(admit("a"), "a");
    assert.equal(admit("b"), "b");
    assert.equal(admit("c"), "other");
    assert.equal(admit(""), "other");
  });

  it("answers nothing for nothing, rather than the fallback", () => {
    const admit = brandedEnumOf(["a"] as const, "other");
    assert.equal(admit(undefined), undefined);
  });

  it("does not admit a value that is not in the list it was given, whatever case it is written in", () => {
    const admit = brandedEnumOf(["ECONNRESET"] as const, SLATE_ERRNO_FALLBACK);
    assert.equal(admit("econnreset"), SLATE_ERRNO_FALLBACK);
  });
});

describe("the errno values the platform reports", () => {
  it("reports one it knows, and folds anything else into the fallback", () => {
    assert.equal(SLATE_ERRNO_TAGS.length, 22);
    assert.equal(SLATE_ERRNO_FALLBACK, "E_OTHER");
    assert.equal(brandedErrno("ECONNREFUSED"), "ECONNREFUSED");
    assert.equal(brandedErrno("ENOENT"), "ENOENT");
    assert.equal(brandedErrno("E_OTHER"), "E_OTHER");
    assert.equal(brandedErrno("something else"), "E_OTHER");
    assert.equal(brandedErrno(undefined), undefined);
  });
});

describe("an id that is safe to report", () => {
  it("admits opaque and short, and refuses anything that could carry a message", () => {
    for (const id of ["abc", "a.b_c-d:e|f", "a".repeat(128), "0"]) assert.equal(brandedId(id), id, id);
    for (const id of ["", "a b", "with\"quote", "line\nbreak", "a".repeat(129), "ünï"]) assert.equal(brandedId(id), undefined, JSON.stringify(id));
    assert.equal(brandedId(undefined), undefined);
  });
});

describe("a literal pinned as one of ours", () => {
  it("comes back as it was written", () => {
    assert.equal(brandLiteralEnum("slate"), "slate");
  });
});
