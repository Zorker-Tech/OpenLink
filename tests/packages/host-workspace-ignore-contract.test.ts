import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKSPACE_IGNORE_FILE_NAME } from "../../source/packages/constants/box-archive.ts";
import { REGENERABLE_WORKSPACE_PATH_PATTERNS } from "../../source/adapters/interop/box/workspace-archive-layout-adapter.ts";
import {
  IGNORE_NOTHING,
  compileRule,
  compileWorkspaceIgnore,
  computeNegationReach,
  globToRegexBody,
  loadWorkspaceIgnore,
  negationReaches,
  parseIgnorePatterns,
} from "../../source/host/boxes/box-store-sync/workspace-ignore.ts";

describe("workspace ignore policy", () => {
  it("exports the file name and default patterns the box store uses", () => {
    assert.equal(WORKSPACE_IGNORE_FILE_NAME, ".slateignore");
    assert.equal(REGENERABLE_WORKSPACE_PATH_PATTERNS.includes("node_modules/"), true);
    assert.equal(REGENERABLE_WORKSPACE_PATH_PATTERNS.includes("dist/"), true);
    assert.equal(new Set(REGENERABLE_WORKSPACE_PATH_PATTERNS).size, REGENERABLE_WORKSPACE_PATH_PATTERNS.length);
  });

  it("parses CRLF and LF lines, drops blank/comment lines, and trims trailing whitespace only", () => {
    assert.deepEqual(parseIgnorePatterns("# comment\r\nnode_modules/  \n\n  \n dist "), ["node_modules/", " dist"]);
    assert.deepEqual(parseIgnorePatterns(""), []);
  });

  it("uses one shared no-op policy when no valid pattern remains", () => {
    const compiled = compileWorkspaceIgnore(parseIgnorePatterns("\n# comment\n"));
    assert.strictEqual(compiled, IGNORE_NOTHING);
    assert.equal(compiled.ignores("anything"), false);
    assert.equal(compiled.canPruneDir("anything"), false);
  });

  it("uses the last matching rule so later negations can restore a file", () => {
    const ignore = compileWorkspaceIgnore(["*.log", "!keep.log", "keep.log"]);
    assert.equal(ignore.ignores("keep.log"), true);
    const restored = compileWorkspaceIgnore(["*.log", "!keep.log"]);
    assert.equal(restored.ignores("keep.log"), false);
    assert.equal(restored.ignores("other.log"), true);
  });

  it("matches a directory pattern only below the named directory", () => {
    const ignore = compileWorkspaceIgnore(["node_modules/"]);
    assert.equal(ignore.ignores("node_modules/package/index.js"), true);
    assert.equal(ignore.ignores("src/node_modules/package/index.js"), true);
    assert.equal(ignore.ignores("node_modules"), false);
    assert.equal(ignore.canPruneDir("node_modules"), true);
  });

  it("anchors slash-containing and leading-slash patterns at the workspace root", () => {
    const ignore = compileWorkspaceIgnore(["/build", "/dist", "src/generated/*.js"]);
    assert.equal(ignore.ignores("build/output.js"), true);
    assert.equal(ignore.ignores("src/build/output.js"), false);
    assert.equal(ignore.ignores("dist/app.js"), true);
    assert.equal(ignore.ignores("nested/dist/app.js"), false);
    assert.equal(ignore.ignores("src/generated/app.js"), true);
    assert.equal(ignore.ignores("nested/src/generated/app.js"), false);
    assert.equal(compileWorkspaceIgnore(["build"]).ignores("src/build/output.js"), true);
  });

  it("keeps single-star and question-mark wildcards within one path segment", () => {
    const star = new RegExp(`^${globToRegexBody("*.js")}$`);
    const question = new RegExp(`^${globToRegexBody("file?.txt")}$`);
    assert.equal(star.test("app.js"), true);
    assert.equal(star.test("src/app.js"), false);
    assert.equal(question.test("file1.txt"), true);
    assert.equal(question.test("file12.txt"), false);
    assert.equal(question.test("file/a.txt"), false);
    assert.equal(question.test("file/.txt"), false);
  });

  it("supports double-star across directories when its position is segment-aligned", () => {
    const ignore = compileWorkspaceIgnore(["**/build/**"]);
    assert.equal(ignore.ignores("build/output.js"), true);
    assert.equal(ignore.ignores("src/deep/build/output.js"), true);
    assert.equal(ignore.ignores("src/deep/builder/output.js"), false);
  });

  it("matches positive, negated and literal character classes", () => {
    const positive = compileWorkspaceIgnore(["file[0-9].txt"]);
    const negative = compileWorkspaceIgnore(["file[!ab].txt"]);
    assert.equal(positive.ignores("file7.txt"), true);
    assert.equal(positive.ignores("filex.txt"), false);
    assert.equal(negative.ignores("filec.txt"), true);
    assert.equal(negative.ignores("filea.txt"), false);
    assert.equal(compileRule("file[0-9].txt")?.negated, false);
  });

  it("treats an unmatched opening bracket as a literal bracket", () => {
    const ignore = compileWorkspaceIgnore(["folder/[name"]);
    assert.equal(ignore.ignores("folder/[name"), true);
    assert.equal(ignore.ignores("folder/name"), false);
  });

  it("escapes regular-expression punctuation in literal pattern text", () => {
    const ignore = compileWorkspaceIgnore(["literal.(txt)"]);
    assert.equal(ignore.ignores("literal.(txt)"), true);
    assert.equal(ignore.ignores("literalXtxt"), false);
  });

  it("treats escaped comment and negation markers as literal names", () => {
    const ignore = compileWorkspaceIgnore(["\\!important", "\\#notes"]);
    assert.equal(ignore.ignores("!important"), true);
    assert.equal(ignore.ignores("#notes"), true);
  });

  it("fails open when an invalid negated glob cannot be compiled", () => {
    assert.strictEqual(compileWorkspaceIgnore(["!file[z-a].txt"]), IGNORE_NOTHING);
    assert.strictEqual(compileWorkspaceIgnore(["node_modules/", "!file[z-a].txt"]), IGNORE_NOTHING);
    assert.equal(compileWorkspaceIgnore(["file[z-a].txt"]).ignores("anything"), false);
  });

  it("keeps a directory open when a negation could reach inside it", () => {
    const ignore = compileWorkspaceIgnore(["node_modules/", "!node_modules/keep.js"]);
    assert.equal(ignore.ignores("node_modules/other.js"), true);
    assert.equal(ignore.ignores("node_modules/keep.js"), false);
    assert.equal(ignore.canPruneDir("node_modules"), false);
    assert.equal(negationReaches({ everywhere: false, literalPrefix: "node_modules/keep.js" }, "node_modules"), true);
  });

  it("prunes an ignored directory when no negation can reach it", () => {
    const ignore = compileWorkspaceIgnore(["build/", "!src/keep.js"]);
    assert.equal(ignore.canPruneDir("build"), true);
    assert.equal(ignore.canPruneDir("src"), false);
    assert.equal(negationReaches({ everywhere: false, literalPrefix: "build/keep.js" }, "src"), false);
    assert.equal(negationReaches({ everywhere: true, literalPrefix: "" }, "anywhere"), true);
    assert.equal(negationReaches(undefined, "anywhere"), false);
  });

  it("widens negation reach at unanchored patterns and the first wildcard", () => {
    assert.deepEqual(computeNegationReach("keep.log", false), { everywhere: true, literalPrefix: "" });
    const reach = computeNegationReach("build/*/keep.log", true);
    assert.deepEqual(reach, { everywhere: false, literalPrefix: "build" });
    assert.equal(negationReaches(reach, "build/other"), true);
  });

  it("loads the workspace file after defaults so local negations take precedence", (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "slate-workspace-ignore-contract-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    writeFileSync(join(workspace, WORKSPACE_IGNORE_FILE_NAME), "!node_modules/keep.js\nlogs/*.json\n", "utf8");
    const ignore = loadWorkspaceIgnore(workspace);
    assert.equal(ignore.ignores("node_modules/package/index.js"), true);
    assert.equal(ignore.ignores("node_modules/keep.js"), false);
    assert.equal(ignore.ignores("logs/error.json"), true);
    assert.equal(ignore.ignores("src/app.ts"), false);
  });

  it("uses explicit defaults and tolerates a missing or unreadable ignore file", (t) => {
    const root = mkdtempSync(join(tmpdir(), "slate-workspace-ignore-missing-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const empty = loadWorkspaceIgnore(join(root, "missing"), []);
    assert.strictEqual(empty, IGNORE_NOTHING);
    const withDefaults = loadWorkspaceIgnore(join(root, "missing"), ["cache/"]);
    assert.equal(withDefaults.ignores("cache/file"), true);

    const unreadable = join(root, "unreadable");
    mkdirSync(join(unreadable, WORKSPACE_IGNORE_FILE_NAME), { recursive: true });
    const fallback = loadWorkspaceIgnore(unreadable, ["cache/"]);
    assert.equal(fallback.ignores("cache/file"), true);
  });
});
