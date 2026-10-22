import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CapabilitiesSchema,
  CapabilitySchema,
} from "../../source/packages/plugin-install/capabilities.ts";

describe("the capabilities a plugin may declare", () => {
  it("understands the names the platform has", () => {
    assert.equal(CapabilitySchema.safeParse("canvas").success, true);
    assert.equal(CapabilitySchema.safeParse("other").success, false);
    assert.equal(CapabilitySchema.safeParse("").success, false);
    assert.equal(CapabilitySchema.safeParse(42).success, false);
    assert.deepEqual(CapabilitySchema.options, ["canvas"]);
  });

  it("reads a declared list as one entry per capability", () => {
    assert.deepEqual(CapabilitiesSchema.safeParse([]), { success: true, data: [] });
    assert.deepEqual(CapabilitiesSchema.safeParse(["canvas"]), { success: true, data: ["canvas"] });
    const repeated = CapabilitiesSchema.safeParse(["canvas", "canvas", "canvas"]);
    assert.equal(repeated.success, true);
    assert.deepEqual(repeated.success ? repeated.data : undefined, ["canvas"], "a name declared twice is one capability");
  });

  it("refuses anything that is not a list of understood names", () => {
    for (const value of [["other"], "canvas", null, undefined, 0, {}, [1], ["canvas", "other"], [null], [["canvas"]]]) {
      assert.equal(CapabilitiesSchema.safeParse(value).success, false, JSON.stringify(value));
    }
  });

  it("is an optional field of a manifest", () => {
    const optional = CapabilitiesSchema.optional();
    assert.deepEqual(optional.safeParse(undefined), { success: true, data: undefined });
    assert.deepEqual(optional.safeParse(["canvas"]), { success: true, data: ["canvas"] });
    assert.equal(optional.safeParse(["other"]).success, false);
  });
});
