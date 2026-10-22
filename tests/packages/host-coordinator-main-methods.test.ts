import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COORDINATOR_MAIN_METHOD_TABLE,
  isCoordinatorMainMethod,
} from "../../source/shared/rpc/coordinator-main.ts";

describe("the methods the coordinator's main connection answers to", () => {
  it("says, for every method, whether it is called with an object or with nothing", () => {
    const table = COORDINATOR_MAIN_METHOD_TABLE as Record<string, { readonly args: string }>;
    assert.equal(Object.keys(table).length, 19);
    for (const [name, spec] of Object.entries(table)) assert.equal(spec.args === "object" || spec.args === "none", true, name);
    assert.deepEqual(table["uploadAttachment"], { args: "object" });
    assert.deepEqual(table["getHostSettings"], { args: "none" });
  });

  it("lists exactly the three that take nothing", () => {
    const table = COORDINATOR_MAIN_METHOD_TABLE as Record<string, { readonly args: string }>;
    assert.deepEqual(Object.keys(table).filter((name) => table[name]?.args === "none"), ["getHostSettings", "getHostStatus", "listAgents"]);
  });

  it("keeps the methods in the order the table names them", () => {
    const names = Object.keys(COORDINATOR_MAIN_METHOD_TABLE);
    assert.equal(names[0], "uploadAttachment");
    assert.equal(names.at(-1), "setGatewayPaused");
  });

  it("tells a method of the surface from anything else, including what every object has", () => {
    assert.equal(isCoordinatorMainMethod("uploadAttachment"), true);
    assert.equal(isCoordinatorMainMethod("listAgents"), true);
    for (const other of ["", "upload", "toString", "constructor", "__proto__", "hasOwnProperty"]) assert.equal(isCoordinatorMainMethod(other), false, other);
  });
});
