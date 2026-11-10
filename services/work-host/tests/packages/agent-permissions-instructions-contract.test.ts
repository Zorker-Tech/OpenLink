import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeAutoRunPolicyInstructions,
  resolveSmartModeAutoRunInstructions,
} from "../../source/packages/agent/utils/permissions-instructions.ts";

describe("smart-mode permission instructions", () => {
  it("drops empty strings, preserves ordering and whitespace, and leaves stored arrays untouched", () => {
    const allowInstructions = ["first", "", " ", "last"];
    const blockInstructions = ["", "deny"];
    const stored = { allowInstructions, blockInstructions };

    assert.deepEqual(normalizeAutoRunPolicyInstructions(stored), {
      allowInstructions: ["first", " ", "last"],
      blockInstructions: ["deny"],
    });
    assert.notEqual(normalizeAutoRunPolicyInstructions(stored)?.allowInstructions, allowInstructions);
    assert.deepEqual(allowInstructions, ["first", "", " ", "last"]);
    assert.deepEqual(blockInstructions, ["", "deny"]);
  });

  it("keeps user and project layers when the administrator supplied no effective instruction", () => {
    const result = resolveSmartModeAutoRunInstructions({
      user: { allowInstructions: ["user"], blockInstructions: [] },
      project: { allowInstructions: [], blockInstructions: ["project block"] },
      administrator: { allowInstructions: [""], blockInstructions: [] },
    });

    assert.equal(result.hasAdminOverride, false);
    assert.deepEqual(result.userAutoRunInstructions, { allowInstructions: ["user"], blockInstructions: [] });
    assert.deepEqual(result.projectAutoRunInstructions, { allowInstructions: [], blockInstructions: ["project block"] });
  });

  it("lets any effective administrator instruction replace both lower layers", () => {
    const result = resolveSmartModeAutoRunInstructions({
      user: { allowInstructions: ["user"], blockInstructions: ["user block"] },
      project: { allowInstructions: ["project"], blockInstructions: ["project block"] },
      administrator: { allowInstructions: [""], blockInstructions: ["admin block"] },
    });

    assert.equal(result.hasAdminOverride, true);
    assert.equal(result.userAutoRunInstructions, undefined);
    assert.deepEqual(result.projectAutoRunInstructions, { allowInstructions: [], blockInstructions: ["admin block"] });
  });

  it("represents absent or wholly empty layers as absent", () => {
    assert.equal(normalizeAutoRunPolicyInstructions(undefined), undefined);
    assert.equal(normalizeAutoRunPolicyInstructions({ allowInstructions: [], blockInstructions: [] }), undefined);
    assert.deepEqual(resolveSmartModeAutoRunInstructions({}), {
      userAutoRunInstructions: undefined,
      projectAutoRunInstructions: undefined,
      hasAdminOverride: false,
    });
  });
});
