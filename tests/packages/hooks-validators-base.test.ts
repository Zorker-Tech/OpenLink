import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createValidationResult,
  isObject,
  isString,
  validateOptionalString,
} from "../../source/packages/hooks/validators/validation.ts";

describe("a response validator's shape", () => {
  it("tells text and records from everything else", () => {
    for (const value of ["", "text"]) assert.equal(isString(value), true, value);
    for (const value of [0, true, null, undefined, [], {}, Symbol("s")]) assert.equal(isString(value), false, String(typeof value));
    for (const value of [{}, { a: 1 }, new Date(0), Object.create(null)]) assert.equal(isObject(value), true);
    for (const value of [null, undefined, [], ["a"], "text", 0, true]) assert.equal(isObject(value), false, String(value));
  });

  it("answers whether the response can be obeyed and the problems found", () => {
    assert.deepEqual(createValidationResult(true), { isValid: true, errors: [] });
    assert.deepEqual(createValidationResult(false, ["one problem"]), { isValid: false, errors: ["one problem"] });
    assert.deepEqual(Object.keys(createValidationResult(true)), ["isValid", "errors"]);
  });

  it("gives every answer its own default problem list, and keeps the list it is given", () => {
    const first = createValidationResult(true);
    const second = createValidationResult(true);
    assert.notEqual(first.errors, second.errors);
    const given = ["one problem"];
    assert.equal(createValidationResult(false, given).errors, given);
  });

  it("flags a provided field that is not text, and only that", () => {
    const errors: string[] = [];
    validateOptionalString(undefined, "field", errors);
    validateOptionalString("value", "field", errors);
    validateOptionalString("", "field", errors);
    assert.deepEqual(errors, []);
    validateOptionalString(7, "count", errors);
    validateOptionalString(null, "maybe", errors);
    assert.deepEqual(errors, ["count must be a string if provided", "maybe must be a string if provided"]);
    const existing = ["existing"];
    validateOptionalString([], "list", existing);
    assert.deepEqual(existing, ["existing", "list must be a string if provided"]);
  });
});
