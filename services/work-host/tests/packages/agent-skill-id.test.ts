import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as skillIdModule from "../../source/packages/agent/skill-id.ts";
import { getSkillIdFromPath } from "../../source/packages/agent/skill-id.ts";

describe("a skill's identifier", () => {
  it("is the name of the directory the skill lives in", () => {
    assert.equal(getSkillIdFromPath("/a/b/skills/my-skill/SKILL.md"), "my-skill");
    assert.equal(getSkillIdFromPath("/a/b/skills/my-skill/"), "my-skill");
    assert.equal(getSkillIdFromPath("~/.claude/skills/pdf/SKILL.md"), "pdf");
    assert.equal(getSkillIdFromPath("folder with space/SKILL.md"), "folder with space");
    assert.equal(getSkillIdFromPath("代理/スキル/SKILL.md"), "スキル");
    assert.deepEqual(Object.keys(skillIdModule), ["getSkillIdFromPath"]);
  });

  it("takes either separator, and any number of trailing ones", () => {
    assert.equal(getSkillIdFromPath("C:\\Users\\me\\.skills\\my-skill\\SKILL.md"), "my-skill");
    assert.equal(getSkillIdFromPath("/a/b/skills/my-skill/SKILL.md///"), "my-skill");
    assert.equal(getSkillIdFromPath("/a//b///my-skill//SKILL.md"), "my-skill");
    assert.equal(getSkillIdFromPath("/a/.skills/SKILL.md"), ".skills");
  });

  it("only removes a SKILL.md that is the file at the end, in any case", () => {
    assert.equal(getSkillIdFromPath("/a/skill/Skill.Md"), "skill");
    assert.equal(getSkillIdFromPath("/a/skill/SKILL.MD"), "skill");
    // The suffix needs its own separator: a bare file name is the identifier, and a SKILL.md further in is a directory.
    assert.equal(getSkillIdFromPath("SKILL.md"), "SKILL.md");
    assert.equal(getSkillIdFromPath("/a/SKILL.md/extra"), "extra");
    assert.equal(getSkillIdFromPath("/a/foo.SKILL.md/SKILL.md"), "foo.SKILL.md");
  });

  it("falls back to a word rather than an empty identifier when the path names no directory", () => {
    assert.equal(getSkillIdFromPath(""), "Skill");
    assert.equal(getSkillIdFromPath("/"), "Skill");
    assert.equal(getSkillIdFromPath("////"), "Skill");
    assert.equal(getSkillIdFromPath("/SKILL.md"), "Skill");
    assert.equal(getSkillIdFromPath("C:\\notes.md"), "notes.md", "a path that is only a file keeps the file as its last segment");
    assert.equal(getSkillIdFromPath("C:\\skill.md"), "C:", "a skill file at the root of a drive leaves the drive as the directory");
  });
});