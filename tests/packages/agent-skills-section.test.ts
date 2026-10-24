import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BudgetedAgentSkillsSection } from "../../source/packages/agent/prompts/agent-skills-section.ts";
import { renderContent } from "../../source/packages/prompt-jsx/render-prompt.ts";

function skills(count: number) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push({ fullPath: "/skills/skill-" + index + "/SKILL.md", description: "Skill number " + index + " helps with task " + index + "." });
  }
  return items;
}
const render = (props: Record<string, unknown>) => renderContent(BudgetedAgentSkillsSection(props as never).section);

describe("rendering the agent skills section", () => {
  it("lists every skill when the budget is enough", () => {
    const section = BudgetedAgentSkillsSection({ skillItems: skills(2) } as never);
    assert.equal(section.skillCount, 2);
    assert.equal(section.omittedSkillCount, 0);
    assert.equal(section.strategy, "under_budget");
    const rendered = renderContent(section.section);
    assert.equal(rendered.includes("agent_skills"), true);
    assert.equal(rendered.includes("available_skills"), true);
    assert.equal(rendered.includes("/skills/skill-0/SKILL.md"), true);
    assert.equal(rendered.includes("Skill number 1 helps with task 1."), true);
  });

  it("names the read tool when there is one", () => {
    const withTool = render({ skillItems: skills(1), readToolName: "Read" });
    assert.equal(withTool.includes("Use the Read tool with the provided absolute path"), true);
    assert.equal(withTool.includes("using the Read tool"), true);
    const withoutTool = render({ skillItems: skills(1) });
    assert.equal(withoutTool.includes("Fetch full contents from the provided absolute path"), true);
    assert.equal(withoutTool.includes("Use the Read tool"), false);
  });

  it("uses the shorter invocation rule for the gpt model family", () => {
    const gpt = render({ skillItems: skills(1), isGpt56: true });
    assert.equal(gpt.includes("The user"), true);
    assert.equal(gpt.includes("material action or pause"), true);
    assert.equal(gpt.includes("IMMEDIATELY"), false);
    const plain = render({ skillItems: skills(1) });
    assert.equal(plain.includes("read and follow it IMMEDIATELY"), true);
    assert.equal(plain.includes("material action or pause"), false);
  });

  it("omits skills over the budget and says where they still live", () => {
    const section = BudgetedAgentSkillsSection({ skillItems: skills(20), agentTokenLimit: 1 } as never);
    assert.equal(section.omittedSkillCount > 0, true);
    assert.equal(section.skillCount < 20, true);
    assert.equal(section.strategy !== "under_budget", true);
    const rendered = renderContent(section.section);
    assert.equal(rendered.includes("Additional skills omitted from this initial list"), true);
    assert.equal(rendered.includes("/skills/skill-"), true);
    assert.equal(rendered.includes("No skills are listed below"), true);
  });

  it("carries the section description in both modes", () => {
    const raw = render({ skillItems: skills(1), raw: true, readToolName: "Read" });
    const normal = render({ skillItems: skills(1), readToolName: "Read" });
    assert.equal(raw.includes("Skills the agent can use. Use the Read tool"), true);
    assert.equal(normal.includes("Skills the agent can use. Use the Read tool"), true);
    assert.notEqual(raw, normal);
  });

  it("reports the estimated token counts", () => {
    const section = BudgetedAgentSkillsSection({ skillItems: skills(3), agentTokenLimit: 12_000 } as never);
    assert.equal(section.skillCount, 3);
    assert.equal(section.renderedEstimatedTokens > 0, true);
    assert.equal(section.uncappedEstimatedTokens >= section.renderedEstimatedTokens, true);
    assert.equal(section.omittedSkillCount, 0);
  });
});
