import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { lenientArray } from "../../source/packages/agent/tools/lenient-array.ts";

const primitiveItems = z.object({ items: lenientArray(z.array(z.string()), { field: "items", primitiveItems: true }) });
const structuredItems = z.object({ items: lenientArray(z.array(z.string()), { field: "items" }) });
const anyItems = z.object({ items: lenientArray(z.array(z.unknown()), { field: "items", primitiveItems: true }) });

describe("lenient array argument behavior", () => {
  it("accepts a JSON array or an already parsed array", () => {
    assert.deepEqual(primitiveItems.parse({ items: '["a","b"]' }), { items: ["a", "b"] });
    assert.deepEqual(primitiveItems.parse({ items: ["a"] }), { items: ["a"] });
  });

  it("wraps one primitive but refuses text that could name several items", () => {
    assert.deepEqual(primitiveItems.parse({ items: "single item" }), { items: ["single item"] });
    assert.equal(primitiveItems.safeParse({ items: "one, two" }).success, false);
    assert.equal(primitiveItems.safeParse({ items: "one\ntwo" }).success, false);
    assert.equal(structuredItems.safeParse({ items: "single item" }).success, false);
  });

  it("strips only a single parameter wrapper naming the field being parsed", () => {
    assert.deepEqual(primitiveItems.parse({ items: '<parameter name="items">["a"]</parameter>' }), { items: ["a"] });
    assert.equal(primitiveItems.safeParse({ items: '<parameter name="other">["a"]</parameter>' }).success, false);
    assert.equal(primitiveItems.safeParse({ items: '<parameter name="items">["a"]</parameter><parameter name="items">["b"]</parameter>' }).success, false);
    assert.equal(primitiveItems.safeParse({ items: '<parameter name="items">["a"]</parameter><parameter name="other">["b"]</parameter>' }).success, false);
  });

  it("recovers a complete leading array only when its remaining tail carries no content", () => {
    assert.deepEqual(anyItems.parse({ items: '["a", {"text":"]}"}],' }), { items: ["a", { text: "]}" }] });
    assert.equal(primitiveItems.safeParse({ items: '["a"] unexpected' }).success, false);
    assert.equal(primitiveItems.safeParse({ items: '["a"] ["b"]' }).success, false);
  });

  it("refuses duplicate object keys while allowing repeated array values", () => {
    assert.equal(z.object({ items: lenientArray(z.array(z.unknown()), { field: "items" }) }).safeParse({ items: '[{"a":1,"a":2}]' }).success, false);
    assert.deepEqual(primitiveItems.parse({ items: '["a","a"]' }), { items: ["a", "a"] });
  });

  it("leaves empty and non-array values to the receiving schema while wrapping an ordinary scalar", () => {
    assert.equal(primitiveItems.safeParse({ items: "  " }).success, false);
    assert.deepEqual(primitiveItems.parse({ items: "not json" }), { items: ["not json"] });
    assert.equal(structuredItems.safeParse({ items: "not json" }).success, false);
    assert.equal(primitiveItems.safeParse({ items: "{\"a\":1}" }).success, false);
  });
});
