import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { processVideoAttachment } from "../../source/packages/agent/context/video-attachment.ts"
import type { AttachmentBlobStore } from "../../source/packages/agent/context/attachment-hydration.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { SelectedVideo } from "../../source/packages/proto/generated/agent/v1/selected_context_pb.ts"
import type { WriteArgs } from "../../source/packages/proto/generated/agent/v1/write_exec_pb.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"

// ---------------------------------------------------------------------------------------------
// the three things a video is moved through: a blob store, a write executor, and an upload URL
// ---------------------------------------------------------------------------------------------

function blobHarness(): { store: AttachmentBlobStore<Context>; blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (blobId: Uint8Array): string => Buffer.from(blobId).toString("hex")
  return {
    blobs,
    store: {
      async getBlob(_ctx, blobId) { return blobs.get(keyOf(blobId)) },
      async setBlob(_ctx, blobId, data) { blobs.set(keyOf(blobId), data) },
      async setBlobLocallyOnly(_ctx, blobId, data) { blobs.set(keyOf(blobId), data) },
    },
  }
}

function writeHarness(failWith?: Error): { writes: WriteArgs[]; accessor: { get(): { execute(ctx: Context, args: WriteArgs): Promise<unknown> } } } {
  const writes: WriteArgs[] = []
  return {
    writes,
    accessor: {
      get: () => ({
        async execute(_ctx, args) {
          if (failWith !== undefined) throw failWith
          writes.push(args)
          return {}
        },
      }),
    },
  }
}

interface UploadHarness {
  readonly requests: Array<{ url: string; method: string; contentType: string; body: Uint8Array }>
  readonly provider: {
    getSignedUrlForAttachedMedia(ctx: Context, request: { conversationId: string; key?: string; mimeType: string; contentLengthBytes?: number }): Promise<{
      key: string
      putUrl: string
      getUrl: string
      expiresAtUnixMs: bigint
      refreshAfterUnixMs: bigint
    }>
  }
  readonly asked: Array<{ conversationId: string; key?: string; mimeType: string; contentLengthBytes?: number }>
}

function uploadHarness(): UploadHarness {
  const requests: UploadHarness["requests"] = []
  const asked: UploadHarness["asked"] = []
  return {
    requests,
    asked,
    provider: {
      async getSignedUrlForAttachedMedia(_ctx, request) {
        asked.push(request)
        return {
          key: request.key ?? "generated-key",
          putUrl: `https://storage.test/put/${request.key ?? "generated-key"}`,
          getUrl: `https://storage.test/get/${request.key ?? "generated-key"}`,
          expiresAtUnixMs: 1_000n,
          refreshAfterUnixMs: 500n,
        }
      },
    },
  }
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

type VideoOverrides = Partial<{
  path: string
  filename: string
  mimeType: string
  fps: number
  materializeToFilesystem: boolean
  data: Uint8Array
  dataOrBlobId: SelectedVideo["dataOrBlobId"]
}>

const video = (overrides: VideoOverrides = {}): SelectedVideo =>
  new SelectedVideo({
    path: overrides.path ?? "",
    filename: overrides.filename ?? "clip.mp4",
    mimeType: overrides.mimeType ?? "video/mp4",
    materializeToFilesystem: overrides.materializeToFilesystem ?? false,
    ...(overrides.fps === undefined ? {} : { fps: overrides.fps }),
    ...(overrides.dataOrBlobId !== undefined
      ? { dataOrBlobId: overrides.dataOrBlobId }
      : overrides.data === undefined
        ? {}
        : { dataOrBlobId: { case: "data" as const, value: overrides.data } }),
  })

async function process(
  selectedVideo: SelectedVideo,
  options: {
    modelId?: string
    maxVideoBytes?: number
    workspaceRoot?: string
    projectFolder?: string
    index?: number
    writes?: ReturnType<typeof writeHarness>
    withResourceAccessor?: boolean
    privacyMode?: PrivacyMode
    uploads?: UploadHarness
    conversationId?: string
  } = {},
): Promise<ReturnType<typeof processVideoAttachment>> {
  const writes = options.writes ?? writeHarness()
  const env = options.workspaceRoot === undefined && options.projectFolder === undefined
    ? undefined
    : {
      ...(options.projectFolder === undefined ? {} : { projectFolder: options.projectFolder }),
      workspacePaths: options.workspaceRoot === undefined ? [] : [options.workspaceRoot],
    }
  return await processVideoAttachment({
    ctx: createContext(),
    blobStore: blobHarness().store,
    selectedVideo,
    index: options.index ?? 0,
    modelId: options.modelId ?? "gemini-2.5-pro",
    maxVideoBytes: options.maxVideoBytes ?? 10 * 1024 * 1024,
    requestContext: env === undefined ? undefined : { env },
    resourceAccessor: options.withResourceAccessor === false ? undefined : writes.accessor,
    ...(options.privacyMode === undefined ? {} : { privacyMode: options.privacyMode }),
    ...(options.uploads === undefined ? {} : { attachedMediaUrlProvider: options.uploads.provider }),
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
  })
}

// ---------------------------------------------------------------------------------------------
// what is refused before anything is moved
// ---------------------------------------------------------------------------------------------

test("a video is only sent to a model that can watch one", async () => {
  await assert.rejects(
    () => process(video({ data: bytesOf("frames") }), { modelId: "composer-2" }),
    /Video attachments are only supported for Gemini models/,
  )
  // A model with no name at all is not one that can watch a video either.
  await assert.rejects(
    () => process(video({ data: bytesOf("frames") }), { modelId: "" }),
    /Video attachments are only supported for Gemini models/,
  )
})

test("a video written to disk does not need a model that can watch one", async () => {
  const writes = writeHarness()
  const result = await process(video({ data: bytesOf("frames"), materializeToFilesystem: true }), {
    modelId: "composer-2",
    writes,
    workspaceRoot: "/repo",
  })
  assert.equal(result.localFilePath !== undefined, true)
})

test("a frame rate the platform cannot support is refused", async () => {
  for (const fps of [0.1, 25, Number.NaN]) {
    await assert.rejects(
      () => process(video({ data: bytesOf("x"), fps })),
      /Video fps must be between 0\.25 and 20/,
    )
  }
  for (const fps of [0.25, 20]) {
    const result = await process(video({ data: bytesOf("x"), fps }))
    assert.equal(result.fps, fps)
  }
})

test("a video with no frame rate given is left without one", async () => {
  const result = await process(video({ data: bytesOf("x") }))
  assert.equal(result.fps, undefined)
})

test("a video has to be a video by its mime type", async () => {
  await assert.rejects(() => process(video({ data: bytesOf("x"), mimeType: "application/pdf" })), /require a video\/\* mime type/)
  await assert.rejects(() => process(video({ data: bytesOf("x"), mimeType: "" })), /require a video\/\* mime type/)
})

test("an attachment with no data behind it is refused", async () => {
  await assert.rejects(() => process(video({})), /Video attachment has no data/)
})

test("a signed URL in a session that may not store media is refused rather than fetched", async () => {
  await assert.rejects(
    () => process(video({ dataOrBlobId: { case: "signedUrl", value: { url: "https://x", key: "k", conversationId: "c" } as never } }), {
      privacyMode: PrivacyMode.NO_STORAGE,
      uploads: uploadHarness(),
    }),
    /Attached media signed URLs are not available in this privacy mode/,
  )
})

// ---------------------------------------------------------------------------------------------
// bytes handed to a model that watches them
// ---------------------------------------------------------------------------------------------

test("a video's bytes are handed to the model and stored on the way", async () => {
  const data = bytesOf("the frames")
  const result = await process(video({ data }))
  assert.deepEqual(result.videoData, data)
  assert.equal(result.localFilePath, undefined)
  assert.equal(result.mimeType, "video/mp4")
  assert.equal(result.filename, "clip.mp4")
  assert.equal(result.processedSelectedVideo?.dataOrBlobId?.case, "blobId")
})

test("a video past the size cap is refused rather than truncated", async () => {
  await assert.rejects(
    () => process(video({ data: bytesOf("too big") }), { maxVideoBytes: 3 }),
    /Video exceeds maximum size of 3 bytes \(0MB\)/,
  )
})

test("a video whose stored bytes are gone is an error rather than an empty video", async () => {
  await assert.rejects(
    () => process(video({ dataOrBlobId: { case: "blobId", value: new Uint8Array([7, 7]) } })),
    /Video not found in blob store/,
  )
})

test("a video that carries both a reference and its bytes uses the bytes", async () => {
  const data = bytesOf("inline frames")
  const result = await process(video({ dataOrBlobId: { case: "blobIdWithData", value: { data, blobId: new Uint8Array([1]) } as never } }))
  assert.deepEqual(result.videoData, data)
})

test("a video is named after its path when it has no filename of its own", async () => {
  const fromPath = await process(video({ data: bytesOf("x"), filename: "", path: "/tmp/somewhere/recorded.mp4" }))
  assert.equal(fromPath.filename, "recorded.mp4")

  const fromNothing = await process(video({ data: bytesOf("x"), filename: "", path: "" }), { index: 4 })
  assert.match(fromNothing.filename, /^video-\d+-4$/)
})

// ---------------------------------------------------------------------------------------------
// a video written to disk for a subagent that cannot be handed its bytes
// ---------------------------------------------------------------------------------------------

test("a materialised video is written into the workspace and referred to by path", async () => {
  const writes = writeHarness()
  const data = bytesOf("the frames")
  const result = await process(video({ data, materializeToFilesystem: true }), { writes, workspaceRoot: "/repo" })

  assert.equal(writes.writes.length, 1)
  const written = writes.writes[0]
  assert.equal(path.dirname(written?.path ?? ""), "/repo/uploads")
  assert.match(path.basename(written?.path ?? ""), /^clip_[a-z0-9]{4}\.mp4$/)
  assert.deepEqual(written?.fileBytes, data)
  assert.equal(result.localFilePath, written?.path)
  assert.equal(result.processedSelectedVideo?.path, written?.path)
  // The bytes are not also sent: the model reads the video from the path it was given.
  assert.equal(result.videoData, undefined)
})

test("a materialised video prefers the project folder over the workspace root", async () => {
  const writes = writeHarness()
  const result = await process(video({ data: bytesOf("x"), materializeToFilesystem: true }), {
    writes,
    workspaceRoot: "/repo",
    projectFolder: "/repo/.slate/projects/workspace-1",
  })
  assert.equal(result.localFilePath?.startsWith("/repo/.slate/projects/workspace-1/uploads/"), true)
})

test("a video that cannot be written is dropped, and the turn goes on", async () => {
  const writes = writeHarness(new Error("the workspace is read-only"))
  const result = await process(video({ data: bytesOf("x"), materializeToFilesystem: true }), { writes, workspaceRoot: "/repo" })
  assert.equal(result.localFilePath, undefined)
  assert.equal(result.processedSelectedVideo, undefined)
  assert.equal(result.videoData, undefined)
})

test("a materialised video is not written when the session has nowhere to write it", async () => {
  const withNoAccessor = await process(video({ data: bytesOf("x"), materializeToFilesystem: true }), {
    workspaceRoot: "/repo",
    withResourceAccessor: false,
  })
  assert.equal(withNoAccessor.processedSelectedVideo, undefined)
  assert.equal(withNoAccessor.localFilePath, undefined)

  const withNoRoot = await process(video({ data: bytesOf("x"), materializeToFilesystem: true }))
  assert.equal(withNoRoot.processedSelectedVideo, undefined)
})

// ---------------------------------------------------------------------------------------------
// a video that travels as a signed URL
// ---------------------------------------------------------------------------------------------

test("a video is uploaded once and the model is given a link to it", async () => {
  const uploads = uploadHarness()
  const requests: Array<{ url: string; method: string; contentType: string; body: Uint8Array }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      contentType: String((init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? ""),
      body: init?.body as Uint8Array,
    })
    return { ok: true, status: 200, statusText: "OK" } as Response
  }) as typeof fetch

  try {
    const data = bytesOf("uploaded frames")
    const result = await process(video({ data }), {
      privacyMode: PrivacyMode.NO_TRAINING,
      uploads,
      conversationId: "conversation-1",
    })

    assert.equal(uploads.asked.length, 1)
    assert.equal(uploads.asked[0]?.conversationId, "conversation-1")
    assert.equal(uploads.asked[0]?.contentLengthBytes, data.length)
    assert.deepEqual(requests[0], {
      url: "https://storage.test/put/generated-key",
      method: "PUT",
      contentType: "video/mp4",
      body: data,
    })
    assert.equal(result.videoUrl, "https://storage.test/get/generated-key")
    assert.equal(result.videoData, undefined)
    const signedUrl = result.processedSelectedVideo?.dataOrBlobId
    assert.equal(signedUrl?.case, "signedUrl")
    assert.equal(signedUrl?.case === "signedUrl" ? signedUrl.value.conversationId : "", "conversation-1")
    assert.equal(signedUrl?.case === "signedUrl" ? signedUrl.value.expiresAtUnixMs : 0n, 1_000n)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a video that already has a link has only that link renewed", async () => {
  const uploads = uploadHarness()
  const originalFetch = globalThis.fetch
  let uploadsSeen = 0
  globalThis.fetch = (async () => {
    uploadsSeen += 1
    return { ok: true, status: 200, statusText: "OK" } as Response
  }) as typeof fetch

  try {
    const result = await process(
      video({ dataOrBlobId: { case: "signedUrl", value: { url: "https://old", key: "existing-key", conversationId: "conversation-2" } as never } }),
      { privacyMode: PrivacyMode.NO_TRAINING, uploads },
    )
    // The bytes are already stored, so nothing is uploaded again.
    assert.equal(uploadsSeen, 0)
    assert.equal(uploads.asked[0]?.key, "existing-key")
    assert.equal(uploads.asked[0]?.conversationId, "conversation-2")
    assert.equal(result.videoUrl, "https://storage.test/get/existing-key")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a video that is too large to upload is refused before it is uploaded", async () => {
  const uploads = uploadHarness()
  await assert.rejects(
    () => process(video({ data: bytesOf("far too much video") }), {
      privacyMode: PrivacyMode.NO_TRAINING,
      uploads,
      maxVideoBytes: 4,
    }),
    /Video exceeds maximum size of 4 bytes \(0MB\)/,
  )
  assert.deepEqual(uploads.asked, [])
})

test("a failed upload is reported rather than swallowed", async () => {
  const uploads = uploadHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }) as Response) as typeof fetch
  try {
    await assert.rejects(
      () => process(video({ data: bytesOf("frames") }), { privacyMode: PrivacyMode.NO_TRAINING, uploads }),
      /Failed to upload attached media: 503 Service Unavailable/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a stored video is uploaded from its stored bytes", async () => {
  const blobs = blobHarness()
  const uploads = uploadHarness()
  const data = bytesOf("stored frames")
  const blobId = await getBlobId(data)
  await blobs.store.setBlob(createContext(), blobId, data)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, status: 200, statusText: "OK" }) as Response) as typeof fetch
  try {
    const result = await processVideoAttachment({
      ctx: createContext(),
      blobStore: blobs.store,
      selectedVideo: video({ dataOrBlobId: { case: "blobId", value: blobId } }),
      index: 0,
      modelId: "gemini-2.5-pro",
      maxVideoBytes: 1024,
      requestContext: undefined,
      resourceAccessor: undefined,
      privacyMode: PrivacyMode.NO_TRAINING,
      attachedMediaUrlProvider: uploads.provider,
      conversationId: "conversation-3",
    })
    assert.equal(uploads.asked[0]?.contentLengthBytes, data.length)
    assert.equal(result.videoUrl, "https://storage.test/get/generated-key")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a stored video whose bytes are gone is an error even when it would have been uploaded", async () => {
  const uploads = uploadHarness()
  await assert.rejects(
    () => process(video({ dataOrBlobId: { case: "blobId", value: new Uint8Array([3, 3]) } }), {
      privacyMode: PrivacyMode.NO_TRAINING,
      uploads,
    }),
    /Video not found in blob store/,
  )
})
