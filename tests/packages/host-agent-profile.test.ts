import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  SLATE_PROFILE_FILENAME,
  getSlateProfilePath,
  readLegacyProfileAvatarField,
  readSlateProfileFile,
  writeSlateProfileFile,
  type SlateAgentProfile,
} from "../../source/host/agents/agent-profile.ts";

const roots: string[] = [];
/** An agent directory of this test's own, removed afterwards. */
const agentDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slate-profile-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const profile: SlateAgentProfile = { name: "Scout", description: "finds things", title: "  Reviewer  ", avatarShape: " circle ", avatarColor: " #fff " };

describe("where an agent's profile lives", () => {
  it("is one file beside the agent", () => {
    assert.equal(SLATE_PROFILE_FILENAME, "profile.json");
    assert.equal(getSlateProfilePath("/agents/a1"), join("/agents/a1", "profile.json"));
  });
});

describe("writing an agent's profile", () => {
  it("writes it beside the agent, with the padding trimmed off the three shaped fields", () => {
    const dir = agentDir();
    const path = getSlateProfilePath(dir);
    writeSlateProfileFile(path, profile);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(written["name"], "Scout");
    assert.equal(written["description"], "finds things");
    assert.equal(written["title"], "Reviewer");
    assert.equal(written["avatarShape"], "circle");
    assert.equal(written["avatarColor"], "#fff");
    assert.equal(readFileSync(path, "utf8").endsWith("}\n"), true, "the file ends in a newline, as a text file should");
  });

  it("makes the agent's directory, and leaves no temporary file behind", () => {
    const dir = join(agentDir(), "nested", "deeper");
    writeSlateProfileFile(getSlateProfilePath(dir), profile);
    assert.deepEqual(readSlateProfileFile(getSlateProfilePath(dir)), { ...profile, title: "Reviewer", avatarShape: "circle", avatarColor: "#fff" });
  });
});

describe("reading an agent's profile", () => {
  it("answers nothing when the file is missing, unreadable or not a record", () => {
    const dir = agentDir();
    assert.equal(readSlateProfileFile(getSlateProfilePath(dir)), null);
    writeFileSync(getSlateProfilePath(dir), "not json");
    assert.equal(readSlateProfileFile(getSlateProfilePath(dir)), null);
    writeFileSync(getSlateProfilePath(dir), "[]");
    assert.equal(readSlateProfileFile(getSlateProfilePath(dir)), null);
  });

  it("reads a field that is not a text as empty, and the padding off a text that is", () => {
    const dir = agentDir();
    writeFileSync(getSlateProfilePath(dir), JSON.stringify({ name: "Scout", description: 5, title: "  Reviewer  ", avatarShape: null }));
    assert.deepEqual(readSlateProfileFile(getSlateProfilePath(dir)), { name: "Scout", description: "", title: "Reviewer", avatarShape: "", avatarColor: "" });
  });

  it("reads the avatar a profile was written with before the shape and colour were separate", () => {
    const dir = agentDir();
    writeFileSync(getSlateProfilePath(dir), JSON.stringify({ avatar: "  circle  " }));
    assert.equal(readLegacyProfileAvatarField(getSlateProfilePath(dir)), "circle");
    writeFileSync(getSlateProfilePath(dir), JSON.stringify({ avatar: "   " }));
    assert.equal(readLegacyProfileAvatarField(getSlateProfilePath(dir)), null);
    writeFileSync(getSlateProfilePath(dir), JSON.stringify({ avatar: 5 }));
    assert.equal(readLegacyProfileAvatarField(getSlateProfilePath(dir)), null);
  });
});
