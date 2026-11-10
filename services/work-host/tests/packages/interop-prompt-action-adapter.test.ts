import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import {
  SelectedImage,
  SelectedVideo,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts";
import type { SlateImageAttachment } from "../../source/packages/agent/context/image-attachment-contracts.ts"
import type { SlateVideoAttachment } from "../../source/packages/agent/context/video-attachment-contracts.ts"
import {
  slateTurnActionFromPrompt,
  hydrateInteropSelectedVideos,
  interopTurnPromptOptionsFromRunner,
} from "../../source/adapters/interop/agent/prompt-action-adapter.ts";

describe("prompt action interop adapter", () => {
  it("filters runner attachments into the prompt boundary and preserves optional values", () => {
    const video = new SelectedVideo({ uuid: "v1", path: "/workspace/a.mp4", mimeType: "video/mp4", filename: "a.mp4", materializeToFilesystem: false, dataOrBlobId: { case: "blobId", value: new Uint8Array([4]) } });
    const options = interopTurnPromptOptionsFromRunner({
      selectedImages: [{ data: new Uint8Array([1]), path: "/workspace/a.png", mimeType: "image/png" }, { data: "bad" }],
      selectedVideos: [video, { uuid: "bad" }],
      attachedFilePaths: ["/workspace/file.txt"],
      messageId: "message-1",
      recentUserMessages: [{ id: "prior", text: "earlier" }],
    });
    assert.deepEqual(options.selectedImages, [new SelectedImage({
      uuid: "",
      path: "/workspace/a.png",
      mimeType: "image/png",
      dataOrBlobId: { case: "data", value: new Uint8Array([1]) },
    })]);
    assert.deepEqual(options.selectedVideos, [video]);
    assert.deepEqual([options.attachedFilePaths, options.messageId, options.recentUserMessages], [["/workspace/file.txt"], "message-1", [{ id: "prior", text: "earlier" }]]);
  });

  it("keeps Slate image/video selections intact until the generated prompt boundary", () => {
    const image: SlateImageAttachment = {
      id: "image-1",
      sourcePath: "/workspace/image.png",
      mediaType: "image/png",
      content: { kind: "blob-with-bytes", blobId: new Uint8Array([5]), bytes: new Uint8Array([1, 2]) },
    }
    const video: SlateVideoAttachment = {
      id: "video-1",
      sourcePath: "/workspace/video.mp4",
      displayName: "video.mp4",
      mediaType: "video/mp4",
      writeToWorkspace: false,
      content: { kind: "bytes", bytes: new Uint8Array([3, 4]) },
    }
    const options = interopTurnPromptOptionsFromRunner({ selectedImages: [image], selectedVideos: [video] })
    assert.deepEqual(options.selectedImages, [new SelectedImage({
      uuid: "image-1",
      path: "/workspace/image.png",
      mimeType: "image/png",
      dataOrBlobId: { case: "blobIdWithData", value: { blobId: new Uint8Array([5]), data: new Uint8Array([1, 2]) } },
    })])
    assert.deepEqual(options.selectedVideos?.[0]?.dataOrBlobId, { case: "data", value: new Uint8Array([3, 4]) })
  })

  it("hydrates only unmaterialized subagent videos and keeps the caller's refusal", async () => {
    const ready = new SelectedVideo({ uuid: "ready", path: "/workspace/ready.mp4", mimeType: "video/mp4", filename: "ready.mp4", materializeToFilesystem: false, dataOrBlobId: { case: "blobId", value: new Uint8Array([2]) } });
    const pending = new SelectedVideo({ uuid: "pending", path: "/workspace/pending.mp4", mimeType: "video/mp4", filename: "pending.mp4", materializeToFilesystem: false });
    const bytes = new Uint8Array([8, 9]);
    const resolved = await hydrateInteropSelectedVideos({ videos: [ready, pending], isSubagentRunner: true, readBytes: async () => bytes, missingVideoError: (label) => new Error(`cannot read ${label}`) });
    assert.equal(resolved[0], ready);
    assert.equal(resolved[1]?.dataOrBlobId.case, "data");
    if (resolved[1]?.dataOrBlobId.case === "data") assert.equal(resolved[1].dataOrBlobId.value, bytes);
    await assert.rejects(
      hydrateInteropSelectedVideos({ videos: [pending], isSubagentRunner: true, readBytes: async () => null, missingVideoError: (label) => new Error(`cannot read ${label}`) }),
      { message: "cannot read pending.mp4" },
    );
  });

  it("encodes the Slate message, selected context and follow-up messages once at the boundary", () => {
    const prepended = new UserMessage({ text: "prior message" });
    const result = slateTurnActionFromPrompt({
      text: "hello",
      messageId: "message-2",
      richText: "<p>hello</p>",
      selectedImages: [{ data: new Uint8Array([3]), path: "/workspace/p.png", mimeType: "image/png" }],
      selectedVideos: [],
      prependUserMessages: [prepended],
      unansweredQuestionsNote: "Unanswered questions:\n- where?",
      automationStatusReminder: null,
      automationStatusCompactionEpoch: 4,
    });
    assert.equal(result.action.kind, "user-message");
    assert.equal(result.action.payload.schema, "slate.agent-action.user-message");
    assert.equal(result.action.payload.version, 1);
    assert.deepEqual([
      result.action.payload.message?.text,
      result.action.payload.message?.messageId,
      result.action.payload.message?.richText,
    ], ["hello", "message-2", "<p>hello</p>"]);
    assert.equal(result.action.payload.message?.selectedContext?.media.images.length, 1);
    assert.equal(result.action.payload.earlierMessages[0]?.text, "prior message");
    assert.equal(result.action.payload.earlierMessages[1]?.text, "Unanswered questions:\n- where?");
  });
});
