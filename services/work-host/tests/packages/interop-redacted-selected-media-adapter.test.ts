import assert from "node:assert/strict"
import test from "node:test"

import {
  SelectedDocument,
  SelectedDocument_BlobIdWithData,
  SelectedImage,
  SelectedImage_BlobIdWithData,
  SelectedVideo,
  SelectedVideo_SignedUrl,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  toRedactedSelectedDocument,
  toRedactedSelectedImage,
  toRedactedSelectedVideo,
} from "../../source/adapters/interop/redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { fromInteropSelectedImage } from "../../source/adapters/interop/agent/selected-context-entry-adapter.ts"
import { fromInteropSelectedDocument } from "../../source/adapters/interop/agent/document-attachment-adapter.ts"
import { fromInteropSelectedVideo } from "../../source/adapters/interop/agent/video-attachment-adapter.ts"

test("redacted image data and path are restored before Slate consumes the attachment", () => {
  const source = new SelectedImage({
    uuid: "image-1",
    path: "/private/image.png",
    mimeType: "image/png",
    dataOrBlobId: {
      case: "blobIdWithData",
      value: new SelectedImage_BlobIdWithData({
        blobId: new Uint8Array([1, 2]),
        data: new Uint8Array([7, 8, 9]),
      }),
    },
  })

  const restored = fromInteropSelectedImage(
    toRedactedSelectedImage(source, PrivacyMode.NO_STORAGE) as unknown as SelectedImage,
  )

  assert.equal(restored.sourcePath, "/private/image.png")
  assert.deepEqual(restored.content, {
    kind: "blob-with-bytes",
    blobId: new Uint8Array([1, 2]),
    bytes: new Uint8Array([7, 8, 9]),
  })
})

test("redacted video data, path, and display name survive the Slate projection", () => {
  const source = new SelectedVideo({
    uuid: "video-1",
    path: "/private/clip.mp4",
    filename: "clip.mp4",
    mimeType: "video/mp4",
    materializeToFilesystem: true,
    dataOrBlobId: { case: "data", value: new Uint8Array([4, 5, 6]) },
  })

  const restored = fromInteropSelectedVideo(
    toRedactedSelectedVideo(source, PrivacyMode.NO_STORAGE) as unknown as SelectedVideo,
  )

  assert.equal(restored.sourcePath, "/private/clip.mp4")
  assert.equal(restored.displayName, "clip.mp4")
  assert.deepEqual(restored.content, { kind: "bytes", bytes: new Uint8Array([4, 5, 6]) })
})

test("redacted document content and filesystem metadata survive the Slate projection", () => {
  const source = new SelectedDocument({
    uuid: "document-1",
    filename: "notes.txt",
    mimeType: "text/plain",
    path: "/private/notes.txt",
    dataOrBlobId: {
      case: "blobIdWithData",
      value: new SelectedDocument_BlobIdWithData({
        blobId: new Uint8Array([2]),
        data: new Uint8Array([11, 12]),
      }),
    },
  })

  const restored = fromInteropSelectedDocument(
    toRedactedSelectedDocument(source, PrivacyMode.NO_STORAGE) as unknown as SelectedDocument,
  )

  assert.equal(restored.filename, "notes.txt")
  assert.equal(restored.path, "/private/notes.txt")
  assert.deepEqual(restored.content, {
    kind: "blob-with-bytes",
    blobId: new Uint8Array([2]),
    bytes: new Uint8Array([11, 12]),
  })
})

test("redacted signed video links retain their private URL value through projection", () => {
  const source = new SelectedVideo({
    path: "/private/clip.mp4",
    filename: "clip.mp4",
    mimeType: "video/mp4",
    dataOrBlobId: {
      case: "signedUrl",
      value: new SelectedVideo_SignedUrl({
        url: "https://media.example.test/signed",
        key: "asset-key",
        expiresAtUnixMs: 100n,
        refreshAfterUnixMs: 50n,
        conversationId: "conversation-1",
      }),
    },
  })

  const restored = fromInteropSelectedVideo(
    toRedactedSelectedVideo(source, PrivacyMode.NO_STORAGE) as unknown as SelectedVideo,
  )

  assert.deepEqual(restored.content, {
    kind: "signed-link",
    url: "https://media.example.test/signed",
    key: "asset-key",
    expiresAtUnixMs: 100n,
    refreshAfterUnixMs: 50n,
    conversationId: "conversation-1",
  })
})
