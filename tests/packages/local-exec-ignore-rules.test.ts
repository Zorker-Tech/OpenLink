import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseIgnoreRules } from "../../source/packages/local-exec/ignore-rules.ts";

describe("an ignore file", () => {
  it("is its patterns, in the order they were written", () => {
    assert.deepEqual(parseIgnoreRules("node_modules\ndist\n*.log"), ["node_modules", "dist", "*.log"]);
    assert.deepEqual(parseIgnoreRules(""), []);
    assert.deepEqual(parseIgnoreRules("   \n\t\n "), []);
  });

  it("drops comments and blank lines, including indented comments", () => {
    assert.deepEqual(parseIgnoreRules("# a comment"), []);
    assert.deepEqual(parseIgnoreRules("node_modules\n\n# build\ndist"), ["node_modules", "dist"]);
    assert.deepEqual(parseIgnoreRules("   # indented comment\nnode_modules"), ["node_modules"]);
  });

  it("takes the line ending and the leading whitespace off, and nothing else", () => {
    assert.deepEqual(parseIgnoreRules("  node_modules"), ["node_modules"]);
    assert.deepEqual(parseIgnoreRules("node_modules   "), ["node_modules   "], "trailing whitespace is part of the pattern");
    assert.deepEqual(parseIgnoreRules("node_modules\r\ndist\r\n"), ["node_modules", "dist"]);
    assert.deepEqual(parseIgnoreRules("a\rb"), ["a\rb"], "a carriage return inside a line is content");
    assert.deepEqual(parseIgnoreRules("a#b"), ["a#b"], "a hash inside a pattern is content");
    assert.deepEqual(parseIgnoreRules("\\\#literal"), ["\\#literal"]);
  });

  it("keeps an ignore file's mixture in one pass", () => {
    assert.deepEqual(parseIgnoreRules("# deps\nnode_modules/\n\n  # build\ndist/\n  *.log\n*.tmp  \r\n"), ["node_modules/", "dist/", "*.log", "*.tmp  "]);
  });
});
