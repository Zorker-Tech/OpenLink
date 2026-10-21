import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePermissionsAutoRunConfig,
  parseProjectPermissionsFileConfig,
} from "../../source/packages/config/project-permissions-file-provider.ts";

describe("a project's own permissions file", () => {
  it("is read with its comments and trailing commas, because it is written by hand", () => {
    const config = parseProjectPermissionsFileConfig('{\n  // what may run unattended\n  "autoRun": { "allow_instructions": ["npm test"], },\n}');
    assert.deepEqual(config, { autoRun: { allowInstructions: ["npm test"], blockInstructions: undefined } });
  });

  it("is absent when it has a real error in it, rather than half-read", () => {
    for (const raw of ["", "{", "not json", "null", "[]", '"text"']) assert.equal(parseProjectPermissionsFileConfig(raw), undefined, raw);
  });

  it("reads both spellings of the policy, preferring the older one when both are written", () => {
    assert.deepEqual(parseProjectPermissionsFileConfig('{"autoRun":{"allow_instructions":["new"]}}'), { autoRun: { allowInstructions: ["new"], blockInstructions: undefined } });
    assert.deepEqual(parseProjectPermissionsFileConfig('{"autoReview":{"allow_instructions":["old"]}}'), { autoRun: { allowInstructions: ["old"], blockInstructions: undefined } });
    const both = parseProjectPermissionsFileConfig('{"autoRun":{"allow_instructions":["new"]},"autoReview":{"allow_instructions":["old"]}}');
    assert.deepEqual(both, { autoRun: { allowInstructions: ["old"], blockInstructions: undefined } });
  });

  it("has no policy when the field is not a record", () => {
    for (const raw of ['{"autoRun":null}', '{"autoRun":[]}', '{"autoRun":"text"}', "{}"]) {
      assert.deepEqual(parseProjectPermissionsFileConfig(raw), { autoRun: undefined }, raw);
    }
  });
});

describe("the policy a permissions file holds", () => {
  it("keeps the strings of each list, and reads a list that is not one as absent", () => {
    assert.deepEqual(parsePermissionsAutoRunConfig({ allow_instructions: ["a", 5, "b"], block_instructions: [] }), { allowInstructions: ["a", "b"], blockInstructions: [] });
    assert.deepEqual(parsePermissionsAutoRunConfig({ allow_instructions: "nope" }), { allowInstructions: undefined, blockInstructions: undefined });
    assert.deepEqual(parsePermissionsAutoRunConfig({}), { allowInstructions: undefined, blockInstructions: undefined });
  });

  it("is nothing at all for a value that is not a record", () => {
    for (const value of [null, undefined, [], "text", 5]) assert.equal(parsePermissionsAutoRunConfig(value), undefined, JSON.stringify(value));
  });
});
