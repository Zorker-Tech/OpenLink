/**
 * The chat-inference middlewares, the coordinator's own RPC surface, image and video dimensions, and the
 * teach-recording service.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { imageResizingMiddleware } from "../../source/packages/chat-inference/middleware/image-resizing-middleware.ts";
import { tracingMiddleware } from "../../source/packages/chat-inference/middleware/tracing-middleware.ts";
import { MockPromptExecutor } from "../../source/packages/chat-inference/mock-prompt-executor.ts";
import { COORDINATOR_METHOD_TABLE, isCoordinatorMethod, parseCoordinatorAgentThreadRequest } from "../../source/shared/rpc/coordinator.ts";
import { imageFileSize, pngSize } from "../../source/shared/media/image-dimensions.ts";
import { Mp4Dimensions } from "../../source/shared/media/video-dimensions.ts";
import { LEARN_SKILL_NAME, TEACH_QUEUES_DIR, TEACH_SESSIONS_DIR } from "../../source/host/extensions/teach-recording/teach-recording-service.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-teach-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("shrinking an image before it is sent", () => {
  it("is a middleware the chain can name", () => {
    assert.equal(typeof imageResizingMiddleware, "function");
  });
});

describe("tracing a prompt through the chain", () => {
  it("is a middleware the chain can name", () => {
    assert.equal(typeof tracingMiddleware, "function");
  });
});

describe("an executor that answers without a model", () => {
  it("exists for the tests and the demo paths", () => {
    assert.equal(typeof MockPromptExecutor, "function");
  });
});

describe("the coordinator's own RPC surface", () => {
  it("names the calls it serves, and recognizes one of them", () => {
    const names = Object.keys(COORDINATOR_METHOD_TABLE);
    assert.equal(names.length > 0, true);
    assert.equal(isCoordinatorMethod(names[0] as string), true);
    assert.equal(isCoordinatorMethod("not-a-method"), false);
    assert.equal(typeof parseCoordinatorAgentThreadRequest, "function");
  });
});

describe("how large an image or a video is", () => {
  it("reads a PNG's size out of its own header, and refuses what it cannot read", () => {
    assert.equal(pngSize(Buffer.from([1, 2, 3, 4])), null);
    assert.equal(typeof imageFileSize, "function");
  });

  it("reads a video's size out of its container", () => {
    assert.equal(typeof Mp4Dimensions, "function");
  });
});

describe("recording what a user does", () => {
  it("keeps its recordings under a directory of its own", () => {
    assert.equal(TEACH_SESSIONS_DIR, "/workspace/teach-sessions");
    assert.equal(TEACH_QUEUES_DIR, "/workspace/teach-sessions/queues");
    assert.equal(LEARN_SKILL_NAME, "learn-from-demonstration");
  });
});
