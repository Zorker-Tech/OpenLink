import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SelectedContext,
  SelectedCursorCommand,
  SelectedImage,
  SelectedPluginCapabilityRef,
  SelectedPluginCapabilityType,
  SelectedVideo,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  fromInteropTaskSelectedContext,
  toInteropTaskSelectedContext,
} from "../../source/adapters/interop/agent/task-subagent-preparation-protocol-adapter.ts"
import { cloneSlateTaskAttachmentSelection } from "../../source/packages/agent/tools/task-attachment-contracts.ts"

test("task attachment records map to Slate names and round-trip every supported field", () => {
  const source = new SelectedContext({
    selectedImages: [new SelectedImage({
      uuid: "image-1",
      path: "/workspace/image.png",
      mimeType: "image/png",
      dataOrBlobId: { case: "data", value: new Uint8Array([1, 2, 3]) },
    })],
    selectedVideos: [new SelectedVideo({
      uuid: "video-1",
      path: "/workspace/clip.mp4",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      fps: 4,
      materializeToFilesystem: true,
      dataOrBlobId: { case: "data", value: new Uint8Array([4, 5]) },
    })],
    cursorCommands: [new SelectedCursorCommand({
      name: "review",
      content: "review the changes",
      fullPath: "/workspace/.slate/commands/review.md",
      displayName: "Review",
      pluginCapability: new SelectedPluginCapabilityRef({
        pluginId: "plugin-1",
        capabilityType: SelectedPluginCapabilityType.COMMAND,
        sourcePath: "/workspace/plugin",
        snapshotToken: "snapshot-token-test",
        resolvedCommitSha: "abc123",
      }),
    })],
  })

  const slate = fromInteropTaskSelectedContext(source)
  assert.ok(slate)
  assert.equal(slate.images[0]?.id, "image-1")
  assert.equal(slate.videos[0]?.id, "video-1")
  assert.deepEqual(slate.commands[0], {
    name: "review",
    content: "review the changes",
    sourcePath: "/workspace/.slate/commands/review.md",
    displayName: "Review",
    capability: {
      pluginId: "plugin-1",
      capability: "command",
      sourcePath: "/workspace/plugin",
      snapshotToken: "snapshot-token-test",
      resolvedCommit: "abc123",
    },
  })

  const restored = toInteropTaskSelectedContext(slate)
  assert.ok(restored)
  assert.equal(SelectedContext.equals(restored, source), true)
})

test("unknown plugin capability values survive conversion and cloned task records own their bytes", () => {
  const imageBytes = new Uint8Array([9, 8])
  const videoBytes = new Uint8Array([7, 6])
  const source = new SelectedContext({
    selectedImages: [new SelectedImage({ uuid: "image-2", dataOrBlobId: { case: "data", value: imageBytes } })],
    selectedVideos: [new SelectedVideo({ uuid: "video-2", dataOrBlobId: { case: "data", value: videoBytes } })],
    cursorCommands: [new SelectedCursorCommand({
      name: "custom",
      content: "run",
      pluginCapability: new SelectedPluginCapabilityRef({ capabilityType: 91 as SelectedPluginCapabilityType }),
    })],
  })
  const slate = fromInteropTaskSelectedContext(source)
  assert.ok(slate)
  const cloned = cloneSlateTaskAttachmentSelection(slate)

  imageBytes[0] = 1
  videoBytes[0] = 2
  assert.deepEqual(cloned.images[0]?.content, { kind: "inline-bytes", bytes: new Uint8Array([9, 8]) })
  assert.deepEqual(cloned.videos[0]?.content, { kind: "bytes", bytes: new Uint8Array([7, 6]) })
  assert.equal(cloned.commands[0]?.capability?.capability, "unknown-91")
  const restored = toInteropTaskSelectedContext(cloned)
  assert.equal(restored?.cursorCommands[0]?.pluginCapability?.capabilityType, 91)
})
