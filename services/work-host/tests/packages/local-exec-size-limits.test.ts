import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_BUFFER_SIZE, MAX_OFS_FILE_SIZE } from "../../source/packages/local-exec/constants.ts";

describe("local execution size limits", () => {
  it("shares byte-sized limits across buffer and output storage", () => {
    assert.equal(MAX_BUFFER_SIZE, 1_048_576);
    assert.equal(MAX_OFS_FILE_SIZE, 52_428_800);
    assert.equal(MAX_OFS_FILE_SIZE / MAX_BUFFER_SIZE, 50);
  });
});
