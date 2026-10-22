import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ASSETS_DIRNAME,
  ATTACHMENTS_DIRNAME,
  getAgentAssetsDir,
  getAgentAttachmentsDir,
  getAgentMediaStoreRoots,
} from "../../source/host/attachments/attachment-paths.ts";

describe("where an agent's uploaded files live", () => {
  it("names the two folders under the agent's directory", () => {
    assert.equal(ATTACHMENTS_DIRNAME, "attachments");
    assert.equal(ASSETS_DIRNAME, "assets");
    assert.equal(getAgentAttachmentsDir("/tmp/agent"), path.join("/tmp/agent", "attachments"));
    assert.equal(getAgentAssetsDir("/tmp/agent"), path.join("/tmp/agent", "assets"));
  });

  it("keeps relative agent directories relative", () => {
    assert.equal(getAgentAttachmentsDir("agent"), path.join("agent", "attachments"));
    assert.equal(getAgentAssetsDir(""), "assets");
  });

  it("answers both media store roots, attachments first", () => {
    assert.deepEqual(getAgentMediaStoreRoots("/tmp/agent"), [
      path.join("/tmp/agent", "attachments"),
      path.join("/tmp/agent", "assets"),
    ]);
    assert.notEqual(getAgentMediaStoreRoots("/tmp/agent"), getAgentMediaStoreRoots("/tmp/agent"), "a fresh tuple each time");
  });
});
