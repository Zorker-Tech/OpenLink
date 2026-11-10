import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptGitWorkflowModelCapability } from "../../source/adapters/interop/agent/git-workflow-model-capability-adapter.ts";
import { shouldInjectGitWorkflowRules } from "../../source/packages/agent/prompts/git-workflow-rule-policy.ts";

describe("git-workflow model capability adapter", () => {
  it("recognizes each supported model family and prompt version", () => {
    for (const modelInfo of [
      { promptVersion: "cursor-0226" },
      { isComposer2: true },
      { isComposer15: true },
      { isComposerMatterhorn: true },
    ]) {
      const capability = adaptGitWorkflowModelCapability(modelInfo);
      assert.equal(capability?.needsGitWorkflowRules, true);
      assert.equal(shouldInjectGitWorkflowRules(capability), true);
    }
  });

  it("keeps unrecognized and raw training variants out of the special guidance path", () => {
    for (const modelInfo of [
      undefined,
      null,
      {},
      { isComposerMatterhorn: true, isRawTrainingSlug: true },
      { isComposer2: false },
    ]) {
      const capability = adaptGitWorkflowModelCapability(modelInfo);
      assert.equal(capability?.needsGitWorkflowRules ?? false, false);
      assert.equal(shouldInjectGitWorkflowRules(capability), false);
    }
  });
});
