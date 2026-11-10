import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_DEFAULT_LOCAL_TOOL_PERMISSION,
  SLATE_LOCAL_TOOL_ACTIONS,
  SLATE_LOCAL_TOOL_PERMISSIONS,
  SLATE_LOCAL_TOOL_PERMISSION_RANK,
  isSlateLocalToolAction,
  isSlateLocalToolPermission,
  normalizeSlateLocalToolPermission,
  resolveSlateLocalToolPermission,
  type SlateLocalToolPermission,
} from "../../source/shared/local-tool-permission.ts";

describe("the local tool vocabularies", () => {
  it("are exactly the values the gate speaks, widest permission first", () => {
    assert.deepEqual([...SLATE_LOCAL_TOOL_PERMISSIONS], ["always", "ask", "never"]);
    assert.deepEqual([...SLATE_LOCAL_TOOL_ACTIONS], ["run-command", "send-input", "read-file", "list-directory", "write-file"]);
    assert.equal(SLATE_DEFAULT_LOCAL_TOOL_PERMISSION, "ask");
  });

  it("rank a permission by its distance from the narrow end, which is the table and the order together", () => {
    // Compared as JSON, not with deepEqual: a record's key order is observable too.
    assert.equal(JSON.stringify(SLATE_LOCAL_TOOL_PERMISSION_RANK), JSON.stringify({ never: 0, ask: 1, always: 2 }));
    for (const [rank, permission] of [...SLATE_LOCAL_TOOL_PERMISSIONS].reverse().entries()) {
      assert.equal(SLATE_LOCAL_TOOL_PERMISSION_RANK[permission], rank, permission);
    }
  });
});

describe("a local tool candidate", () => {
  it("is an action only when it is exactly one of the action names", () => {
    for (const action of SLATE_LOCAL_TOOL_ACTIONS) assert.equal(isSlateLocalToolAction(action), true, action);
    for (const near of ["ALWAYS", "Run-Command", "run_command", "run-command ", " run-command", "", "constructor", "__proto__", "toString"]) {
      assert.equal(isSlateLocalToolAction(near), false, near);
    }
    for (const wrong of [null, undefined, 0, 1, true, new String("read-file"), ["read-file"], { toString: () => "read-file" }]) {
      assert.equal(isSlateLocalToolAction(wrong), false, String(wrong));
    }
  });

  it("is a permission only when it is exactly one of the permission names", () => {
    for (const permission of SLATE_LOCAL_TOOL_PERMISSIONS) assert.equal(isSlateLocalToolPermission(permission), true, permission);
    for (const near of ["Always", "ALWAYS", "ask ", " ask", "", "constructor", "__proto__", "toString", "read-file"]) {
      assert.equal(isSlateLocalToolPermission(near), false, near);
    }
    for (const wrong of [null, undefined, 0, new String("ask"), { toString: () => "never" }]) {
      assert.equal(isSlateLocalToolPermission(wrong), false, String(wrong));
    }
  });

  it("is normalized to its own name when the type allows it, and to the default when it does not", () => {
    for (const permission of SLATE_LOCAL_TOOL_PERMISSIONS) assert.equal(normalizeSlateLocalToolPermission(permission), permission);
    for (const unknown of ["", "Always", " ask", "toString", "__proto__", null, undefined, 1]) {
      assert.equal(normalizeSlateLocalToolPermission(unknown), "ask", String(unknown));
    }
  });
});

describe("a permission choice under an administrator's ceiling", () => {
  it("is left alone without a ceiling", () => {
    assert.equal(resolveSlateLocalToolPermission("always"), "always");
    assert.equal(resolveSlateLocalToolPermission("ask"), "ask");
    assert.equal(resolveSlateLocalToolPermission("never"), "never");
  });

  it("comes back as itself while it does not exceed the ceiling, and as the ceiling when it does", () => {
    const cases: Array<[SlateLocalToolPermission, SlateLocalToolPermission, SlateLocalToolPermission]> = [
      ["always", "always", "always"],
      ["always", "ask", "ask"],
      ["always", "never", "never"],
      ["ask", "always", "ask"],
      ["ask", "ask", "ask"],
      ["ask", "never", "never"],
      ["never", "always", "never"],
      ["never", "ask", "never"],
      ["never", "never", "never"],
    ];
    for (const [choice, ceiling, expected] of cases) {
      assert.equal(resolveSlateLocalToolPermission(choice, ceiling), expected, choice + " under " + ceiling);
    }
  });

  it("answers with a ceiling the type does not allow, because only undefined means no ceiling", () => {
    // A null ceiling is not undefined, so it is ranked like a permission: its rank is missing, the comparison is false,
    // and the bogus ceiling itself comes back. Only the types keep this unreachable.
    assert.equal(resolveSlateLocalToolPermission("always", null as unknown as SlateLocalToolPermission), null);
    assert.equal(resolveSlateLocalToolPermission("never", null as unknown as SlateLocalToolPermission), null);
  });
});
