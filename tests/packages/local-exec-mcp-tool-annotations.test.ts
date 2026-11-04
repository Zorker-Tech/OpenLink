import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_TOOL_ANNOTATION_TITLE_LENGTH,
  normalizeToolAnnotations,
} from "../../source/packages/local-exec/mcp-tool-annotations.ts";

/** The normalizer reads a shape its callers build elsewhere, so a case may hand it anything. */
const normalized = (annotations: unknown) => normalizeToolAnnotations(annotations as never);

describe("tool annotations", () => {
  it("are absent when the tool said nothing", () => {
    assert.equal(normalized(undefined), undefined);
    assert.equal(normalized({}), undefined);
    assert.equal(normalized({ title: "" }), undefined);
    assert.equal(normalized({ title: 7 }), undefined);
    assert.equal(normalized({ readOnlyHint: 0 }), undefined);
    assert.equal(normalized({ title: null }), undefined);
  });

  it("carry a title only when it says something, without trimming it", () => {
    assert.deepEqual(normalized({ title: "searcher" }), { title: "searcher" });
    assert.deepEqual(normalized({ title: " " }), { title: " " }, "a blank title is still a title");
  });

  it("cut a title to the wire's length, in characters", () => {
    assert.equal(MAX_TOOL_ANNOTATION_TITLE_LENGTH, 256);
    const exact = "x".repeat(MAX_TOOL_ANNOTATION_TITLE_LENGTH);
    const overlong = exact + "x";
    assert.deepEqual(normalized({ title: exact }), { title: exact });
    assert.deepEqual(normalized({ title: overlong }), { title: exact });

    // Astral characters count as two units, so the cut can split one and leave a lone surrogate.
    const cut = normalized({ title: "a".repeat(255) + "\u{1F375}" })?.title;
    assert.equal(cut?.length, 256);
    assert.equal(cut, "a".repeat(255) + "\ud83c");
  });

  it("keep a hint only when it is a boolean, so false is kept and the rest is not", () => {
    assert.deepEqual(normalized({ readOnlyHint: true }), { readOnlyHint: true });
    assert.deepEqual(normalized({ readOnlyHint: false }), { readOnlyHint: false });
    for (const notBoolean of [0, 1, "true", "false", null, undefined, [], [true], {}]) {
      assert.equal(normalized({ destructiveHint: notBoolean }), undefined, String(notBoolean));
    }
  });

  it("keeps a stable title and hint order in its own record", () => {
    assert.deepEqual(
      normalized({ openWorldHint: true, idempotentHint: false, destructiveHint: true, readOnlyHint: false, title: "t" }),
      { title: "t", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    )
    assert.deepEqual(normalized({ openWorldHint: false }), { openWorldHint: false }, "a hint can stand on its own")
  });

  it("ignore keys that are not part of an annotation, boolean ones included", () => {
    assert.deepEqual(normalized({ title: "t", extra: 1, anything: { nested: true }, someFlag: true }), { title: "t" });
    assert.equal(normalized({ someFlag: true }), undefined);
  });

  it("read an inherited title or hint like an own one", () => {
    assert.equal(
      JSON.stringify(normalized(Object.create({ title: "inherited", readOnlyHint: true }))),
      '{"title":"inherited","readOnlyHint":true}',
    );
  });

  it("retains Unicode titles and false Boolean hints", () => {
    assert.deepEqual(normalized({ title: "café ☕", idempotentHint: false }), { title: "café ☕", idempotentHint: false });
  });
});
