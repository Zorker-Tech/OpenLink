/**
 * The driver the platform injects into a page: where it is put, what it is called and that its text is
 * ours.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SLATE_BROWSER_DRIVER_BOX_DIR, SLATE_BROWSER_DRIVER_BOX_PATH, SLATE_BROWSER_DRIVER_SOURCE, SLATE_BROWSER_DRIVER_VERSION, SLATE_BROWSER_RESULT_MARKER } from "../../source/host/runner/tools/slate-browser-driver-source.ts";

describe("the source of the browser driver", () => {
  it("is put in the box under our own directory, named by version", () => {
    assert.equal(SLATE_BROWSER_DRIVER_VERSION, 2);
    assert.equal(SLATE_BROWSER_DRIVER_BOX_DIR, "/tmp/.slate-browser");
    assert.equal(SLATE_BROWSER_DRIVER_BOX_PATH, "/tmp/.slate-browser/driver-v2.mjs");
    assert.equal(SLATE_BROWSER_RESULT_MARKER, "__SLATE_BROWSER_RESULT__");
  });

  it("is a self-contained script that names no other product", () => {
    assert.equal(SLATE_BROWSER_DRIVER_SOURCE.length > 30_000, true);
    assert.equal(/cursor/i.test(SLATE_BROWSER_DRIVER_SOURCE), false);
    assert.equal(/grok/i.test(SLATE_BROWSER_DRIVER_SOURCE), false);
    assert.equal(/sand/i.test(SLATE_BROWSER_DRIVER_SOURCE), false);
  });
});
