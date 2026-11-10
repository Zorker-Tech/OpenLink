import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAIN_METHOD_TABLE, MAIN_RPC_CONTRACT_NAME, MAIN_RPC_EVENT_FAMILY, isMainMethod } from "../../source/shared/rpc/main.ts";

describe("the main process's RPC surface", () => {
  it("names its contract and its event family", () => {
    assert.equal(MAIN_RPC_CONTRACT_NAME, "main");
    assert.equal(MAIN_RPC_EVENT_FAMILY, "events");
  });

  it("says, for every method, whether it is called with an object or with nothing", () => {
    const table = MAIN_METHOD_TABLE as Record<string, { readonly args: string }>;
    assert.equal(Object.keys(table).length, 121);
    for (const [name, spec] of Object.entries(table)) assert.ok(spec.args === "object" || spec.args === "none", name);
    assert.deepEqual(table.openExternal, { args: "object" });
    assert.deepEqual(table.getDesktopEnvironment, { args: "none" });
    assert.deepEqual(table.closeWindow, { args: "none" });
    assert.deepEqual(table.toggleMcpToolDisabled, { args: "object" });
  });

  it("keeps the methods that take nothing apart from the ones that take an object", () => {
    const table = MAIN_METHOD_TABLE as Record<string, { readonly args: string }>;
    const without = Object.entries(table).filter(([, spec]) => spec.args === "none").map(([name]) => name);
    assert.equal(without.length, 52);
    assert.equal(without.includes("minimizeWindow"), true);
    assert.equal(without.includes("getMcpState"), true);
    assert.equal(table.resizeWindowWidth?.args, "object");
  });

  it("keeps the table in the order it names the methods, first and last included", () => {
    const names = Object.keys(MAIN_METHOD_TABLE);
    assert.equal(names[0], "openExternal");
    assert.equal(names.at(-1), "toggleMcpToolDisabled");
    assert.equal(names.indexOf("getDesktopEnvironment"), 2);
  });

  it("tells a method of the surface from anything else, including what every object has", () => {
    assert.equal(isMainMethod("openExternal"), true);
    assert.equal(isMainMethod("quitAndInstallUpdate"), true);
    for (const other of ["toString", "constructor", "hasOwnProperty", "__proto__", "", "openExternal ", "OpenExternal", "get", "getNothing", "setSomething", "reportWhatever"]) assert.equal(isMainMethod(other), false, other);
  });
});
