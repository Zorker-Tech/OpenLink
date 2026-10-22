import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_TOOL_ANNOTATION_TITLE_LENGTH,
  toolAnnotationsJsonField,
} from "../../source/packages/local-exec/mcp-tool-annotations.ts";

/** The function reads a shape its callers build elsewhere, so a case may hand it anything. */
const wire = (annotations: unknown) => toolAnnotationsJsonField(annotations as never);

describe("a tool's annotations on the wire", () => {
  it("are absent when the tool said nothing", () => {
    assert.deepEqual(wire(undefined), {});
    assert.deepEqual(wire({}), {});
    assert.deepEqual(wire({ title: "" }), {});
    assert.deepEqual(wire({ title: 7 }), {});
    assert.deepEqual(wire({ readOnlyHint: 0 }), {});
    assert.deepEqual(wire({ title: null }), {});
  });

  it("carry a title only when it says something, without trimming it", () => {
    assert.equal(wire({ title: "searcher" }).annotationsJson, '{"title":"searcher"}');
    assert.equal(wire({ title: " " }).annotationsJson, '{"title":" "}', "a blank title is still a title");
  });

  it("cut a title to the wire's length, in characters", () => {
    assert.equal(MAX_TOOL_ANNOTATION_TITLE_LENGTH, 256);
    const exact = "x".repeat(MAX_TOOL_ANNOTATION_TITLE_LENGTH);
    const overlong = exact + "x";
    assert.equal(wire({ title: exact }).annotationsJson, '{"title":"' + exact + '"}');
    assert.equal(wire({ title: overlong }).annotationsJson, '{"title":"' + exact + '"}');

    // Astral characters count as two units, so the cut can split one and leave a lone surrogate.
    const cut = JSON.parse(wire({ title: "a".repeat(255) + "\u{1F375}" }).annotationsJson as string).title;
    assert.equal(cut.length, 256);
    assert.equal(cut, "a".repeat(255) + "\ud83c");
  });

  it("keep a hint only when it is a boolean, so false is kept and the rest is not", () => {
    assert.equal(wire({ readOnlyHint: true }).annotationsJson, '{"readOnlyHint":true}');
    assert.equal(wire({ readOnlyHint: false }).annotationsJson, '{"readOnlyHint":false}');
    for (const notBoolean of [0, 1, "true", "false", null, undefined, [], [true], {}]) {
      assert.equal(wire({ destructiveHint: notBoolean }).annotationsJson, undefined, String(notBoolean));
    }
  });

  it("write the title first and the hints in the order the wire declares", () => {
    assert.equal(
      wire({ openWorldHint: true, idempotentHint: false, destructiveHint: true, readOnlyHint: false, title: "t" }).annotationsJson,
      '{"title":"t","readOnlyHint":false,"destructiveHint":true,"idempotentHint":false,"openWorldHint":true}',
    );
    assert.equal(
      wire({ openWorldHint: false }).annotationsJson,
      '{"openWorldHint":false}',
      "a hint travels on its own",
    );
  });

  it("ignore keys that are not part of an annotation, boolean ones included", () => {
    assert.equal(wire({ title: "t", extra: 1, anything: { nested: true }, someFlag: true }).annotationsJson, '{"title":"t"}');
    assert.equal(wire({ someFlag: true }).annotationsJson, undefined);
  });

  it("read an inherited title or hint like an own one", () => {
    assert.equal(
      wire(Object.create({ title: "inherited", readOnlyHint: true })).annotationsJson,
      '{"title":"inherited","readOnlyHint":true}',
    );
  });

  it("travel as JSON that parses back to what the tool declared", () => {
    const field = wire({ title: "café ☕", idempotentHint: false });
    assert.deepEqual(Object.keys(field), ["annotationsJson"]);
    assert.deepEqual(JSON.parse(field.annotationsJson as string), { title: "café ☕", idempotentHint: false });
  });
});
