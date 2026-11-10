import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchedManagedSkillToSlateSkill, type FetchedManagedSkill } from "../../source/host/extensions/managed-setup/slate-managed-skills.ts";
import {
  WORKFLOW_MAX_BODY_LENGTH,
  WORKFLOW_MAX_DESCRIPTION_LENGTH,
  WORKFLOW_MAX_NAME_LENGTH,
} from "../../source/shared/workflow-model-contracts.ts";

const skill = (overrides: Partial<FetchedManagedSkill> = {}): FetchedManagedSkill => ({
  id: "review",
  description: "Fetched summary",
  content: "Review the changes.",
  enabled: true,
  ...overrides,
});

describe("managed-skill projection", () => {
  it("omits disabled skills, unsafe identifiers and empty instructions", () => {
    assert.equal(fetchedManagedSkillToSlateSkill(skill({ enabled: false })), null);
    assert.equal(fetchedManagedSkillToSlateSkill(skill({ id: "../escape" })), null);
    assert.equal(fetchedManagedSkillToSlateSkill(skill({ content: "  \n " })), null);
  });

  it("trims the identifier and uses valid frontmatter values with a clean body", () => {
    assert.deepEqual(
      fetchedManagedSkillToSlateSkill(skill({
        id: " review ",
        description: "Fetched summary",
        content: "---\nname: Reviewer\ndescription: Frontmatter summary\n---\n  Review the changes.  ",
      })),
      {
        id: "review",
        name: "Reviewer",
        description: "Frontmatter summary",
        body: "Review the changes.",
      },
    );
  });

  it("falls back to the identifier and fetched description when frontmatter omits those values", () => {
    assert.deepEqual(fetchedManagedSkillToSlateSkill(skill({
      content: "---\nname: \ndescription: \n---\nUse the supplied procedure.",
    })), {
      id: "review",
      name: "review",
      description: "Fetched summary",
      body: "Use the supplied procedure.",
    });
  });

  it("clamps name, description and body to the workflow limits", () => {
    const projected = fetchedManagedSkillToSlateSkill(skill({
      content: `---\nname: ${"n".repeat(100)}\ndescription: ${"d".repeat(2_000)}\n---\n${"x".repeat(100_500)}`,
    }));

    assert.equal(projected?.name.length, WORKFLOW_MAX_NAME_LENGTH);
    assert.equal(projected?.description.length, WORKFLOW_MAX_DESCRIPTION_LENGTH);
    assert.equal(projected?.body.length, WORKFLOW_MAX_BODY_LENGTH);
  });
});
