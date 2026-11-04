import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOX_ATTACHMENT_STAGING_LIMIT_BYTES,
  BOX_ATTACHMENT_STAGING_ROOT,
  stageAttachmentsForAgent,
} from "../../source/host/attachments/box-staging.ts";

function stagingWorld(runState: () => Promise<string>) {
  const uploads: Array<{ boxPath: string; data: Uint8Array }> = [];
  const world = {
    uploads,
    deps: {
      ctx: {},
      box: { runState },
      resolveOwnerDir: (path: string): string | null => path.startsWith("/owned/") ? "/owned" : null,
      upload: async (_ctx: unknown, _box: unknown, _agentId: string, files: readonly { boxPath: string; data: Uint8Array }[]) => {
        uploads.push(...files);
      },
    },
  };
  return world;
}

test("box staging copies only owned, bounded, non-video attachments after the box is running", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-box-staging-"));
  try {
    const image = join(root, "image.png");
    const video = join(root, "clip.mp4");
    const tooLarge = join(root, "large.png");
    writeFileSync(image, new Uint8Array([1, 2, 3]));
    writeFileSync(video, new Uint8Array([4, 5]));
    writeFileSync(tooLarge, "");
    truncateSync(tooLarge, BOX_ATTACHMENT_STAGING_LIMIT_BYTES + 1);

    const world = stagingWorld(async () => "running");
    world.deps.resolveOwnerDir = (path) => path.startsWith(`${root}/`) ? root : null;
    const staged = await stageAttachmentsForAgent(world.deps as never, "agent-a", [
      image,
      video,
      tooLarge,
      "/outside/private.png",
    ]);
    assert.equal(BOX_ATTACHMENT_STAGING_ROOT, "/workspace/uploads");
    assert.deepEqual([...staged], [[image, "/workspace/uploads/image.png"]]);
    assert.deepEqual(world.uploads, [{ boxPath: "/workspace/uploads/image.png", data: new Uint8Array([1, 2, 3]) }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging is quiet before the box runs and fails closed when upload fails", async () => {
  const notRunning = stagingWorld(async () => "starting");
  assert.deepEqual(await stageAttachmentsForAgent(notRunning.deps as never, "agent-a", ["/owned/a.png"]), new Map());
  assert.deepEqual(notRunning.uploads, []);

  const root = mkdtempSync(join(tmpdir(), "slate-box-staging-failure-"));
  try {
    const image = join(root, "image.png");
    writeFileSync(image, "image");
    const failed = stagingWorld(async () => "running");
    failed.deps.resolveOwnerDir = (path) => path.startsWith(`${root}/`) ? root : null;
    failed.deps.upload = async () => { throw new Error("offline"); };
    assert.deepEqual(await stageAttachmentsForAgent(failed.deps as never, "agent-a", [image]), new Map());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
