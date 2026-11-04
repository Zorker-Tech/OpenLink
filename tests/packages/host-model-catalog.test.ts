/**
 * The model catalogue: what a model takes, whether a selection is one of its variants, and what to say when it is not.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeParamIncompatibilities,
  findCatalogEntry,
  validateModelParams,
  validateParamCombination,
  type CatalogModel,
} from "../../source/shared/agents/model-catalog.ts";

/** A model with a fast tier and a 1M context, offered together only in the plain variant. */
const fastAndLong: CatalogModel = {
  id: "slate-pro",
  aliases: ["pro", "SLATE-PRO-LATEST"],
  params: [
    { id: "tier", type: "enum", values: [{ value: "fast" }, { value: "deep" }] },
    { id: "context", type: "enum", values: [{ value: "200k" }, { value: "1m" }] },
  ],
  variants: [
    [{ id: "tier", value: "fast" }, { id: "context", value: "200k" }],
    [{ id: "tier", value: "deep" }, { id: "context", value: "1m" }],
  ],
};

describe("finding a model", () => {
  it("matches the id or an alias, case-insensitively, and nothing for an empty id", () => {
    const catalog = [fastAndLong];
    assert.equal(findCatalogEntry(catalog, "slate-pro"), fastAndLong);
    assert.equal(findCatalogEntry(catalog, "  PRO "), fastAndLong);
    assert.equal(findCatalogEntry(catalog, "slate-pro-latest"), fastAndLong);
    assert.equal(findCatalogEntry(catalog, "other"), undefined);
    assert.equal(findCatalogEntry(catalog, "   "), undefined);
  });
});

describe("a selection the model cannot take", () => {
  it("names the parameter in the way, and says nothing when the selection is a variant", () => {
    assert.equal(validateParamCombination(fastAndLong, { tier: "fast", context: "200k" }), null);
    assert.equal(validateParamCombination(fastAndLong, { tier: "fast" }), null, "a partial selection is covered by the variant it fits");
    assert.equal(validateParamCombination(fastAndLong, {}), null);
    const message = validateParamCombination(fastAndLong, { tier: "fast", context: "1m" });
    assert.match(message!, /^\{tier=fast, context=1m\} is not a supported parameter combination for slate-pro\./);
    // Neither value alone is the problem: dropping either one leaves a selection a variant covers, and the message says so.
    assert.match(message!, /These parameters can't be combined on slate-pro: tier, context\./);
    assert.match(message!, /Change one of the conflicting parameters and retry/);
    // A model with no variants takes any selection.
    assert.equal(validateParamCombination({ ...fastAndLong, variants: [] }, { tier: "fast", context: "1m" }), null);
  });

  it("checks every value against its own parameter, and the combination only when every value was valid", () => {
    assert.deepEqual(validateModelParams(fastAndLong, { tier: "fast", context: "200k" }), []);
    assert.deepEqual(validateModelParams(fastAndLong, { tier: "fast", unknown: "x" }), ["'unknown' is not a parameter of slate-pro. Allowed parameters: tier, context."]);
    assert.deepEqual(validateModelParams(fastAndLong, { tier: "turbo" }), ["'turbo' is not a valid value for 'tier' on slate-pro. Allowed: fast, deep."]);
    // Both kinds of error are reported together, and the combination is not checked while a value is wrong.
    const both = validateModelParams(fastAndLong, { tier: "turbo", context: "1m" });
    assert.equal(both.length, 1);
    // A model with no parameters says exactly that.
    assert.deepEqual(validateModelParams({ ...fastAndLong, params: [] }, { tier: "fast" }), ["'tier' is not a parameter of slate-pro. This model takes no parameters."]);
    const combination = validateModelParams(fastAndLong, { tier: "fast", context: "1m" });
    assert.equal(combination.length, 1);
    assert.match(combination[0]!, /not a supported parameter combination/);
  });
});

describe("what a model cannot combine", () => {
  it("lists the pairs no variant offers together, each pair once", () => {
    const notes = describeParamIncompatibilities(fastAndLong);
    assert.deepEqual(notes.sort(), ["context=200k cannot be combined with tier=deep", "tier=fast cannot be combined with context=1m"]);
    // Values of the same parameter are never offered together either, and are not an incompatibility to report.
    assert.deepEqual(describeParamIncompatibilities({ ...fastAndLong, variants: [[{ id: "tier", value: "fast" }], [{ id: "tier", value: "deep" }]] }), []);
    assert.deepEqual(describeParamIncompatibilities({ ...fastAndLong, variants: [] }), []);
  });
});
