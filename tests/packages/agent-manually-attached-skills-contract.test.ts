import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderManuallyAttachedSkillsSection } from "../../source/packages/agent/manually-attached-skills.ts";

describe("manually attached skill instructions", () => {
  it("omits the section when nothing was attached", () => {
    assert.equal(renderManuallyAttachedSkillsSection([]), undefined);
  });

  it("uses the directory name, keeps the original path, and removes frontmatter", () => {
    const fullPath = "/project/skills/from-directory/SKILL.md";
    const rendered = renderManuallyAttachedSkillsSection([
      { fullPath, content: "---\nname: frontmatter-name\n---\n  Follow these steps.  " },
    ]);

    assert.match(rendered ?? "", /^<manually_attached_skills>/);
    assert.equal(rendered?.includes(fullPath), true);
    assert.equal(rendered?.replace(fullPath, "").includes("from-directory"), true);
    assert.equal(rendered?.includes("Follow these steps."), true);
    assert.equal(rendered?.includes("frontmatter-name"), false);
    assert.match(rendered ?? "", /<\/manually_attached_skills>/);
  });

  it("derives a skill name from a Windows path and keeps the entry order", () => {
    const rendered = renderManuallyAttachedSkillsSection([
      { fullPath: "C:\\project\\skills\\first\\SKILL.md", content: "first instruction" },
      { fullPath: "C:\\project\\skills\\second\\SKILL.md", content: "second instruction" },
    ]) ?? "";

    assert.equal(rendered.includes("C:\\project\\skills\\first\\SKILL.md"), true);
    assert.equal(rendered.replace("C:\\project\\skills\\first\\SKILL.md", "").includes("first"), true);
    assert.ok(rendered.indexOf("first instruction") < rendered.indexOf("second instruction"));
    assert.equal(rendered.includes("\n\n---\n\n"), true);
  });

  it("caps each rendered instruction body at 100,000 characters", () => {
    const content = "x".repeat(100_250);
    const rendered = renderManuallyAttachedSkillsSection([{ fullPath: "/skills/large/SKILL.md", content }]) ?? "";

    assert.equal(rendered.includes("x".repeat(100_000)), true);
    assert.equal(rendered.includes("x".repeat(100_001)), false);
  });
});
