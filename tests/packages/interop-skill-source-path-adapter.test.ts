import assert from "node:assert/strict"
import { test } from "node:test"

import { classifyInteropSkillSourcePath } from "../../source/adapters/interop/agent/skill-source-path-adapter.ts"

test("external skill-folder layouts are classified into Slate source categories", () => {
  assert.equal(classifyInteropSkillSourcePath("/home/u/.cursor/skills-cursor/x/SKILL.md"), "builtin")
  assert.equal(classifyInteropSkillSourcePath("/home/u/.cursor/plugins/p/x/SKILL.md"), "plugin")
  assert.equal(classifyInteropSkillSourcePath("/home/u/.claude/plugins/p/x/SKILL.md"), "plugin")
  assert.equal(classifyInteropSkillSourcePath("/home/u/.claude/skills/x/SKILL.md"), "other-tool")
  assert.equal(classifyInteropSkillSourcePath("/home/u/.cursor/skills/x/SKILL.md"), "workspace")
  assert.equal(classifyInteropSkillSourcePath("/home/u/.agents/skills/x/SKILL.md"), "workspace")
  assert.equal(classifyInteropSkillSourcePath("/home/u/.cursor/skills-cursor\\x\\SKILL.md"), "builtin")
  assert.equal(classifyInteropSkillSourcePath("/home/u/random/SKILL.md"), "unknown")
})
