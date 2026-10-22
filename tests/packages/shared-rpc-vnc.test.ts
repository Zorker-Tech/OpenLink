import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOX_VNC_METHOD_TABLE,
  BOX_VNC_RPC_CONTRACT_NAME,
  isBoxVncMethod,
} from "../../source/shared/rpc/vnc.ts";

describe("the box VNC contract", () => {
  it("is named, and lists the three methods a connection answers to", () => {
    assert.equal(BOX_VNC_RPC_CONTRACT_NAME, "box-vnc");
    assert.deepEqual(Object.keys(BOX_VNC_METHOD_TABLE), ["readClipboard", "writeClipboard", "reportUserPresence"]);
    assert.deepEqual(Object.entries(BOX_VNC_METHOD_TABLE).map(([method, value]) => [method, value.args]), [
      ["readClipboard", "none"],
      ["writeClipboard", "object"],
      ["reportUserPresence", "object"],
    ]);
  });

  it("gives every method its own argument descriptor", () => {
    assert.notEqual(BOX_VNC_METHOD_TABLE.readClipboard, BOX_VNC_METHOD_TABLE.writeClipboard);
    assert.notEqual(BOX_VNC_METHOD_TABLE.writeClipboard, BOX_VNC_METHOD_TABLE.reportUserPresence);
    assert.deepEqual(Object.keys(BOX_VNC_METHOD_TABLE.readClipboard), ["args"]);
    assert.equal(Object.isFrozen(BOX_VNC_METHOD_TABLE), false, "the table is a plain object, as it has always been");
  });

  it("recognizes its own methods and nothing else", () => {
    for (const method of ["readClipboard", "writeClipboard", "reportUserPresence"]) {
      assert.equal(isBoxVncMethod(method), true, method);
    }
    for (const value of ["", "ReadClipboard", " readClipboard", "readClipboard ", "readFromClipboard", "toString", "hasOwnProperty", "constructor", "__proto__", "valueOf"]) {
      assert.equal(isBoxVncMethod(value), false, JSON.stringify(value));
    }
  });

  it("recognizes a method added to the table at runtime, because it asks the table itself", () => {
    const table = BOX_VNC_METHOD_TABLE as unknown as Record<string, unknown>;
    table.addedLater = { args: "none" };
    try {
      assert.equal(isBoxVncMethod("addedLater"), true);
    } finally {
      delete table.addedLater;
    }
    assert.equal(isBoxVncMethod("addedLater"), false);
  });
});
