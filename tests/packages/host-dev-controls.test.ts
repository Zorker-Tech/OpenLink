import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEV_CONTROLS_METHOD_TABLE,
  DEV_CONTROLS_RPC_CONTRACT_NAME,
  isDevControlsMethod,
} from "../../source/shared/rpc/dev-controls.ts";

describe("the methods the development controls answer to", () => {
  it("names its contract, and every method with the shape of its argument", () => {
    assert.equal(DEV_CONTROLS_RPC_CONTRACT_NAME, "dev-controls");
    const table = DEV_CONTROLS_METHOD_TABLE as Record<string, { readonly args: string }>;
    assert.equal(Object.keys(table).length, 33);
    for (const [method, spec] of Object.entries(table)) assert.equal(spec.args === "object" || spec.args === "none", true, method);
    assert.deepEqual(table["restartElectron"], { args: "none" });
    assert.deepEqual(table["setThemePreference"], { args: "object" });
  });

  it("keeps the methods in the order the table names them", () => {
    const names = Object.keys(DEV_CONTROLS_METHOD_TABLE);
    assert.equal(names[0], "restartElectron");
    assert.equal(names.at(-1), "onePasswordSyntheticProvisioning");
    assert.deepEqual(names.filter((name) => (DEV_CONTROLS_METHOD_TABLE as Record<string, { args: string }>)[name]?.args === "object"), ["setThemePreference", "setAttachProdBoxEnabled", "setWidgetGallery", "setGatewayOffline"]);
  });

  it("tells a method of the surface from anything else, including what every object has", () => {
    assert.equal(isDevControlsMethod("restartElectron"), true);
    assert.equal(isDevControlsMethod("nukeBox"), true);
    for (const other of ["", "restart", "toString", "constructor", "__proto__", "hasOwnProperty"]) assert.equal(isDevControlsMethod(other), false, other);
  });
});
