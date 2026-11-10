import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SKILL_PUBLISH_REFUSAL_PREFIX,
  SlateSkillPublishError,
  SLATE_SKILL_PUBLISH_REFUSED,
  WORKFLOW_REFERENCE_NODE_TYPE,
} from "../../source/shared/workflows.ts";

describe("workflow-owned values", () => {
  it("keeps the rich-text reference marker stable", () => {
    assert.equal(WORKFLOW_REFERENCE_NODE_TYPE, "workflowReference");
  });

  it("formats a publish refusal as a recognizable Slate error", () => {
    const reason = " the requested change was refused ";
    const failure = new SlateSkillPublishError(reason);
    assert.equal(SLATE_SKILL_PUBLISH_REFUSED, "skill-publish/refused");
    assert.equal(SKILL_PUBLISH_REFUSAL_PREFIX, "skill-publish/refused: ");
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.name, "SlateSkillPublishError");
    assert.equal(failure.message, `${SKILL_PUBLISH_REFUSAL_PREFIX}${reason}`);
  });
});
