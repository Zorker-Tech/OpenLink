import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { createContext } from "../../source/packages/context/context.ts"
import { writeExecutorResource, type WriteExecutorArgs } from "../../source/packages/agent-exec/write-operation.ts"
import { writeSelectedImageToProjectAssets } from "../../source/packages/agent/context/image-file-spill.ts"

const ctx = () => createContext()

function recordingWriteExecutor(): {
  accessor: { get(resource: typeof writeExecutorResource): { execute(ctx: unknown, args: WriteExecutorArgs): Promise<unknown> } }
  writes: Array<{ path: string; fileBytes: Uint8Array }>
} {
  const writes: Array<{ path: string; fileBytes: Uint8Array }> = []
  return {
    writes,
    accessor: {
      get: () => ({
        async execute(_ctx: unknown, args: WriteExecutorArgs) {
          writes.push({ path: args.path, fileBytes: args.bytes ?? new Uint8Array() })
          return {}
        },
      }),
    },
  }
}

const imageData = new Uint8Array([1, 2, 3])

function baseArgs(overrides: Record<string, unknown> = {}) {
  const { accessor, writes } = recordingWriteExecutor()
  return {
    writes,
    args: {
      ctx: ctx(),
      imageData,
      selectedImage: { sourcePath: "/p/src/photo.png", id: "image-1" },
      resolvedMimeType: "image/png",
      index: 0,
      enableImageFiles: true,
      requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
      resourceAccessor: accessor,
      ...overrides,
    },
  }
}

test("an image already inside the workspace is used where it is, and nothing is written", () => {
  const { args, writes } = baseArgs()
  const imageFilePath = writeSelectedImageToProjectAssets(args as never)
  assert.equal(imageFilePath, path.normalize("/p/src/photo.png"))
  assert.equal(writes.length, 0)
})

test("an image from outside the workspace is written into the project's assets folder", () => {
  const { args, writes } = baseArgs({ selectedImage: { sourcePath: "/elsewhere/photo.png", id: "image-1" } })
  const imageFilePath = writeSelectedImageToProjectAssets(args as never)
  assert.equal(imageFilePath, path.join("/p", "assets", "photo.png"))
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.path, imageFilePath)
  assert.deepEqual(writes[0]!.fileBytes, imageData)
})

test("the extension comes from the path first, and the mime type when there is no path", () => {
  const fromPath = baseArgs({ selectedImage: { sourcePath: "/elsewhere/photo.jpeg", id: "image-1" }, resolvedMimeType: "image/png" })
  assert.equal(writeSelectedImageToProjectAssets(fromPath.args as never), path.join("/p", "assets", "photo.jpg"))

  const fromMime = baseArgs({ selectedImage: { id: "abc", sourcePath: "" }, resolvedMimeType: "image/gif" })
  assert.equal(writeSelectedImageToProjectAssets(fromMime.args as never), path.join("/p", "assets", "abc.gif"))

  const webp = baseArgs({ selectedImage: { id: "abc", sourcePath: "" }, resolvedMimeType: "image/webp" })
  assert.equal(writeSelectedImageToProjectAssets(webp.args as never), path.join("/p", "assets", "abc.webp"))

  // Anything else, including a mime type with no extension of its own, is written as a PNG.
  const unknown = baseArgs({ selectedImage: { id: "abc", sourcePath: "" }, resolvedMimeType: "image/avif" })
  assert.equal(writeSelectedImageToProjectAssets(unknown.args as never), path.join("/p", "assets", "abc.png"))
})

test("an image with no name at all is named after its identifier", () => {
  const { args } = baseArgs({ selectedImage: { id: "", sourcePath: "" } })
  const imageFilePath = writeSelectedImageToProjectAssets(args as never)
  assert.match(String(imageFilePath), /^\/p\/assets\/image-\d+-0\.png$/)
})

test("an unsafe name is made safe rather than written as it is", () => {
  const { args } = baseArgs({ selectedImage: { sourcePath: "/elsewhere/a b:c.png", id: "image-1" } })
  assert.equal(writeSelectedImageToProjectAssets(args as never), path.join("/p", "assets", "a_b_c.png"))
})

test("nothing is produced when there are no bytes, when the feature is off, or when there is no project", () => {
  assert.equal(writeSelectedImageToProjectAssets(baseArgs({ imageData: undefined }).args as never), undefined)
  assert.equal(writeSelectedImageToProjectAssets(baseArgs({ enableImageFiles: false }).args as never), undefined)
  assert.equal(writeSelectedImageToProjectAssets(baseArgs({ requestContext: undefined }).args as never), undefined)
  assert.equal(
    writeSelectedImageToProjectAssets(baseArgs({ requestContext: { env: { workspacePaths: ["/p"] } } }).args as never),
    undefined,
  )
  assert.equal(
    writeSelectedImageToProjectAssets(baseArgs({ requestContext: { env: { projectFolder: "", workspacePaths: ["/p"] } } }).args as never),
    undefined,
  )
  assert.equal(writeSelectedImageToProjectAssets(baseArgs({ resourceAccessor: undefined }).args as never), undefined)
})

test("a path inside another workspace root is written, since it is not this workspace's file", () => {
  const { args, writes } = baseArgs({
    selectedImage: { sourcePath: "/other/photo.png", id: "image-1" },
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
  })
  assert.equal(writeSelectedImageToProjectAssets(args as never), path.join("/p", "assets", "photo.png"))
  assert.equal(writes.length, 1)
})

test("a write that fails still yields the path the caller asked for", async () => {
  const failing = {
    get: () => ({
      async execute() {
        throw new Error("disk full")
      },
    }),
  }
  const imageFilePath = writeSelectedImageToProjectAssets(baseArgs({
    selectedImage: { sourcePath: "/elsewhere/photo.png", id: "image-1" },
    resourceAccessor: failing,
  }).args as never)
  assert.equal(imageFilePath, path.join("/p", "assets", "photo.png"))
  // The rejection is handled rather than left unhandled.
  await new Promise(resolve => setTimeout(resolve, 5))
})
