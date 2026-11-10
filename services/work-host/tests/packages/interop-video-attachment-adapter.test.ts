import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BackgroundComposerSource,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/background_composer_pb.ts";
import { SelectedVideo } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import {
  fromInteropSelectedVideo,
  processInteropVideoAttachment,
  toInteropSelectedVideo,
} from "../../source/adapters/interop/agent/video-attachment-adapter.ts";
import { backgroundSourceForVideoPolicy } from "../../source/adapters/interop/agent/watch-video-eligibility-adapter.ts";
import type { AttachmentContentStore } from "../../source/packages/agent/context/attachment-hydration.ts";

test("video message variants map to and from Slate's attachment record", () => {
  const video = new SelectedVideo({
    path: "/repo/clip.mp4",
    filename: "clip.mp4",
    mimeType: "video/mp4",
    fps: 2,
    materializeToFilesystem: false,
    dataOrBlobId: { case: "blobId", value: new Uint8Array([1, 2, 3]) },
  });
  const slate = fromInteropSelectedVideo(video);
  assert.deepEqual(slate, {
    sourcePath: "/repo/clip.mp4",
    displayName: "clip.mp4",
    mediaType: "video/mp4",
    frameRate: 2,
    writeToWorkspace: false,
    content: { kind: "blob", blobId: new Uint8Array([1, 2, 3]) },
  });
  assert.deepEqual(toInteropSelectedVideo(slate), video);
});

test("video processing round-trips the updated blob reference through the adapter", async () => {
  const context = createContext();
  const blobs = new Map<string, Uint8Array>();
  const blobStore: AttachmentContentStore<typeof context> = {
    async getBlob(_ctx, id) { return blobs.get(Buffer.from(id).toString("hex")); },
    async setBlob(_ctx, id, data) { blobs.set(Buffer.from(id).toString("hex"), data); },
    async setBlobLocallyOnly(_ctx, id, data) { blobs.set(Buffer.from(id).toString("hex"), data); },
  };
  const input = new SelectedVideo({
    path: "/repo/clip.mp4",
    filename: "clip.mp4",
    mimeType: "video/mp4",
    dataOrBlobId: { case: "data", value: new TextEncoder().encode("frames") },
  });

  const result = await processInteropVideoAttachment({
    ctx: context,
    blobStore,
    selectedVideo: input,
    index: 0,
    modelId: "gemini-2.5-pro",
    maxVideoBytes: 1024,
    requestContext: undefined,
    resourceAccessor: undefined,
  });

  assert.equal(result.videoData?.toString(), new TextEncoder().encode("frames").toString());
  assert.equal(result.processedSelectedVideo?.dataOrBlobId?.case, "blobId");
});

test("only supported background sources become watch-video eligibility values", () => {
  assert.equal(backgroundSourceForVideoPolicy(BackgroundComposerSource.SLACK), "chat");
  assert.equal(backgroundSourceForVideoPolicy(BackgroundComposerSource.AUTOMATIONS), "automation");
  assert.equal(backgroundSourceForVideoPolicy(BackgroundComposerSource.UNSPECIFIED), undefined);
});
