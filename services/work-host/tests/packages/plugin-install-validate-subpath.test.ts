import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { validateAndResolveSubpath } from "../../source/packages/plugin-install/validate-subpath.ts";

describe("a path inside a plugin", () => {
  it("is resolved against the plugin's directory", () => {
    assert.equal(validateAndResolveSubpath("/tmp/plugin", "a/b.txt"), path.resolve("/tmp/plugin/a/b.txt"));
    assert.equal(validateAndResolveSubpath("/tmp/plugin", ""), path.resolve("/tmp/plugin"));
    assert.equal(validateAndResolveSubpath("/tmp/plugin", "a/../b"), path.resolve("/tmp/plugin/b"));
    assert.equal(validateAndResolveSubpath("plugin", "a"), path.resolve("plugin/a"));
  });

  it("is refused when it leaves the plugin, naming the path", () => {
    for (const subPath of ["..", "../a", "a/../../b", "/etc/passwd"]) {
      assert.throws(() => validateAndResolveSubpath("/tmp/plugin", subPath), {
        name: "Error",
        message: "Invalid subPath: path traversal not allowed (" + JSON.stringify(subPath) + ")",
      }, subPath);
    }
  });

  it("quotes the refused path the way JSON does", () => {
    assert.throws(() => validateAndResolveSubpath("/tmp/plugin", '.."quoted'), {
      message: 'Invalid subPath: path traversal not allowed ("..\\"quoted")',
    });
    assert.throws(() => validateAndResolveSubpath("/tmp/plugin", "..\nline"), (error: Error) => {
      assert.equal(error.message, 'Invalid subPath: path traversal not allowed ("..\\nline")');
      return true;
    });
  });
});
