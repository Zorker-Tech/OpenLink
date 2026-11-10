import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptPersistenceModelInfo } from "../../source/adapters/interop/agent/model-persistence-guidance-adapter.ts";
import { usesPersistenceInstructions } from "../../source/packages/agent/prompts/persistence-instructions.ts";

const sourceModelFlags = [
  "isGpt5",
  "isGpt5Family",
  "isGpt51",
  "isGpt52",
  "isGpt54",
  "isGpt55",
  "isGpt56",
  "isGpt52Codex",
  "isGpt53Codex",
  "isGpt53CodexSpark",
] as const;

describe("model persistence-guidance adapter", () => {
  it("maps every supported model flag to the Slate capability", () => {
    for (const flag of sourceModelFlags) {
      const modelInfo = adaptPersistenceModelInfo({ [flag]: true });
      assert.equal(modelInfo?.needsLongRunningWorkGuidance, true, flag);
      assert.equal(usesPersistenceInstructions(modelInfo), true, flag);
    }
  });

  it("does not opt in for false, missing, unrelated, or non-object metadata", () => {
    for (const input of [
      undefined,
      null,
      "not metadata",
      {},
      { isGpt56: false },
      { unrelated: true },
    ]) {
      const modelInfo = adaptPersistenceModelInfo(input);
      assert.equal(modelInfo?.needsLongRunningWorkGuidance ?? false, false);
      assert.equal(usesPersistenceInstructions(modelInfo), false);
    }
  });
});
