import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentSkill } from "../../source/adapters/interop/proto/generated/agent/v1/agent_skills_pb.ts";
import { CursorRule } from "../../source/adapters/interop/proto/generated/agent/v1/rules_pb.ts";
import {
  SelectedContext,
  SelectedCursorRule,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts";
import { decodeSelectedContextSkillAttachments } from "../../source/adapters/interop/agent/selected-context-skills-adapter.ts";

test("selected-context skill fields decode into the host's attachment model", () => {
  const selected = new SelectedContext({
    selectedSkills: [new AgentSkill({
      fullPath: "/repo/skills/release/SKILL.md",
      content: "release guidance",
      plugin: "plugin-a",
      marketplace: "market-a",
      pluginId: "plugin-id-a",
      marketplaceId: "market-id-a",
    })],
    cursorRules: [new SelectedCursorRule({
      rule: new CursorRule({ fullPath: "/repo/.cursor/rules/style.mdc", content: "style guidance" }),
    })],
  });

  assert.deepEqual(decodeSelectedContextSkillAttachments(selected), {
    explicitSkills: [{
      path: "/repo/skills/release/SKILL.md",
      text: "release guidance",
      pluginName: "plugin-a",
      marketplaceName: "market-a",
      pluginId: "plugin-id-a",
      marketplaceId: "market-id-a",
    }],
    ruleCandidates: [{
      path: "/repo/.cursor/rules/style.mdc",
      text: "style guidance",
      pluginName: undefined,
      marketplaceName: undefined,
      pluginId: undefined,
      marketplaceId: undefined,
    }],
  });
});

test("selected-context decoding can unwrap privacy-protected strings", () => {
  const selected = {
    selectedSkills: [{ fullPath: { value: "/repo/SKILL.md" }, content: { value: "body" } }],
    cursorRules: [],
  };
  const decoded = decodeSelectedContextSkillAttachments(selected, (value) =>
    value !== null && typeof value === "object" && "value" in value
      ? String(value.value)
      : typeof value === "string" ? value : undefined,
  );
  assert.deepEqual(decoded.explicitSkills, [{
    path: "/repo/SKILL.md",
    text: "body",
    pluginName: undefined,
    marketplaceName: undefined,
    pluginId: undefined,
    marketplaceId: undefined,
  }]);
});
