import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { processDocumentAttachment } from "../../source/packages/agent/context/document-attachment.ts"
import type { AttachmentBlobStore } from "../../source/packages/agent/context/attachment-hydration.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { SelectedDocument } from "../../source/packages/proto/generated/agent/v1/selected_context_pb.ts"
import type { WriteArgs } from "../../source/packages/proto/generated/agent/v1/write_exec_pb.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"

// ---------------------------------------------------------------------------------------------
// a blob store and a write executor, the two things a document is moved through
// ---------------------------------------------------------------------------------------------

interface BlobHarness {
  readonly store: AttachmentBlobStore<Context>
  readonly blobs: Map<string, Uint8Array>
}

function blobHarness(): BlobHarness {
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (blobId: Uint8Array): string => Buffer.from(blobId).toString("hex")
  return {
    blobs,
    store: {
      async getBlob(_ctx: Context, blobId: Uint8Array) {
        return blobs.get(keyOf(blobId))
      },
      async setBlob(_ctx: Context, blobId: Uint8Array, data: Uint8Array) {
        blobs.set(keyOf(blobId), data)
      },
      async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, data: Uint8Array) {
        blobs.set(keyOf(blobId), data)
      },
    },
  }
}

interface WriteHarness {
  readonly writes: WriteArgs[]
  readonly accessor: { get(): { execute(ctx: Context, args: WriteArgs): Promise<unknown> } }
}

function writeHarness(failWith?: Error): WriteHarness {
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

type DocumentOverrides = Partial<{
  path: string
  filename: string
  mimeType: string
  data: Uint8Array
  dataOrBlobId: SelectedDocument["dataOrBlobId"]
}>

const document = (overrides: DocumentOverrides = {}): SelectedDocument =>
  new SelectedDocument({
    path: overrides.path ?? "",
    filename: overrides.filename ?? "report.pdf",
    mimeType: overrides.mimeType ?? "application/pdf",
    ...(overrides.dataOrBlobId !== undefined
      ? { dataOrBlobId: overrides.dataOrBlobId }
      : overrides.data === undefined
        ? {}
        : { dataOrBlobId: { case: "data" as const, value: overrides.data } }),
  })

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

async function process(
  selectedDocument: SelectedDocument,
  options: {
    blobs?: BlobHarness
    writes?: WriteHarness
    workspaceRoot?: string
    projectFolder?: string
    index?: number
  } = {},
): Promise<ReturnType<typeof processDocumentAttachment>> {
  const blobs = options.blobs ?? blobHarness()
  const writes = options.writes ?? writeHarness()
  const env = options.workspaceRoot === undefined && options.projectFolder === undefined
    ? undefined
    : {
      ...(options.projectFolder === undefined ? {} : { projectFolder: options.projectFolder }),
      workspacePaths: options.workspaceRoot === undefined ? [] : [options.workspaceRoot],
    }
  return await processDocumentAttachment({
    ctx: createContext(),
    blobStore: blobs.store,
    selectedDocument,
    index: options.index ?? 0,
    requestContext: env === undefined ? undefined : { env },
    resourceAccessor: options.writes === undefined && options.writes === null ? undefined : writes.accessor,
  })
}

// ---------------------------------------------------------------------------------------------
// a document that carries its own bytes
// ---------------------------------------------------------------------------------------------

test("a document's bytes are stored and written into the workspace for the agent to open", async () => {
  const blobs = blobHarness()
  const writes = writeHarness()
  const data = bytesOf("the report")
  const result = await process(document({ data }), { blobs, writes, workspaceRoot: "/repo" })

  assert.equal(result.docData !== undefined, true)
  assert.equal(blobs.blobs.size, 1)
  assert.equal(writes.writes.length, 1)
  const written = writes.writes[0]
  assert.equal(path.dirname(written?.path ?? ""), "/repo/uploads")
  // The name keeps its extension and takes a short random suffix, so two uploads cannot collide.
  assert.match(path.basename(written?.path ?? ""), /^report_[a-z0-9]{4}\.pdf$/)
  assert.deepEqual(written?.fileBytes, data)
  assert.equal(written?.returnFileContentAfterWrite, false)
  assert.equal(result.documentFilePath, written?.path)
  assert.equal(result.selectedDocument?.path, written?.path)
  assert.equal(result.mimeType, "application/pdf")
  assert.equal(result.filename, "report.pdf")
})

test("a document written for the agent gets a name that cannot collide with an earlier one", async () => {
  const writes = writeHarness()
  const first = await process(document({ data: bytesOf("one") }), { writes, workspaceRoot: "/repo" })
  const second = await process(document({ data: bytesOf("two") }), { writes, workspaceRoot: "/repo" })
  assert.notEqual(first.documentFilePath, second.documentFilePath)
})

test("the project folder is preferred over the workspace root when both are known", async () => {
  const writes = writeHarness()
  const result = await process(document({ data: bytesOf("x") }), {
    writes,
    workspaceRoot: "/repo",
    projectFolder: "/repo/.slate/projects/workspace-1",
  })
  assert.equal(result.documentFilePath?.startsWith("/repo/.slate/projects/workspace-1/uploads/"), true)
})

test("a filename that is really a path is reduced to its last part", async () => {
  const writes = writeHarness()
  const result = await process(document({ data: bytesOf("x"), filename: "/tmp/somewhere/notes.txt" }), {
    writes,
    workspaceRoot: "/repo",
  })
  assert.match(path.basename(result.documentFilePath ?? ""), /^notes_[a-z0-9]{4}\.txt$/)
  assert.equal(result.filename, "notes.txt")
})

test("a document with no name at all is named after its place in the message", async () => {
  const writes = writeHarness()
  const result = await process(document({ data: bytesOf("x"), filename: "" }), { writes, workspaceRoot: "/repo", index: 3 })
  assert.equal(path.basename(result.documentFilePath ?? "").startsWith("document-"), true)
  assert.equal(result.filename.startsWith("document-"), true)
})

test("bytes that cannot be written into the workspace are dropped, and the turn goes on", async () => {
  const writes = writeHarness(new Error("the workspace is read-only"))
  const result = await process(document({ data: bytesOf("x") }), { writes, workspaceRoot: "/repo" })
  assert.equal(result.docData !== undefined, true)
  assert.equal(result.documentFilePath, undefined)
  assert.equal(result.selectedDocument, undefined)
  assert.equal(writes.writes.length, 0)
})

test("a document is not written anywhere when the session has nowhere to write it", async () => {
  const withNoAccessor = await processDocumentAttachment({
    ctx: createContext(),
    blobStore: blobHarness().store,
    selectedDocument: document({ data: bytesOf("x") }),
    index: 0,
    requestContext: { env: { workspacePaths: ["/repo"] } },
    resourceAccessor: undefined,
  })
  assert.equal(withNoAccessor.docData !== undefined, true)
  assert.equal(withNoAccessor.documentFilePath, undefined)
  assert.equal(withNoAccessor.selectedDocument, undefined)

  const withNoRoot = await process(document({ data: bytesOf("x") }))
  assert.equal(withNoRoot.documentFilePath, undefined)
  assert.equal(withNoRoot.selectedDocument, undefined)
})

// ---------------------------------------------------------------------------------------------
// a document that names bytes already stored
// ---------------------------------------------------------------------------------------------

test("a document that names stored bytes is fetched and written out like any other", async () => {
  const blobs = blobHarness()
  const writes = writeHarness()
  const data = bytesOf("stored bytes")
  const blobId = await getBlobId(data)
  await blobs.store.setBlob(createContext(), blobId, data)

  const result = await process(document({ dataOrBlobId: { case: "blobId", value: blobId } }), {
    blobs,
    writes,
    workspaceRoot: "/repo",
  })
  assert.deepEqual(result.docData, data)
  assert.deepEqual(writes.writes[0]?.fileBytes, data)
  assert.equal(result.documentFilePath !== undefined, true)
})

test("a document whose bytes are no longer stored is an error rather than an empty document", async () => {
  const blobs = blobHarness()
  await assert.rejects(
    () => process(document({ dataOrBlobId: { case: "blobId", value: new Uint8Array([9, 9]) } }), { blobs }),
    /Document not found in blob store/,
  )
})

// ---------------------------------------------------------------------------------------------
// a document that is only a path
// ---------------------------------------------------------------------------------------------

async function withTempWorkspace(run: (workspaceRoot: string, uploadsDir: string) => Promise<void>): Promise<void> {
  const createdRoot = await mkdtemp(path.join(tmpdir(), "slate-document-"))
  const uploadsDir = path.join(createdRoot, "uploads")
  await mkdir(uploadsDir, { recursive: true })
  try {
    // The platform's workspace paths are the real ones, and a trusted path is compared after resolving it.
    await run(await realpath(createdRoot), await realpath(uploadsDir))
  } finally {
    await rm(createdRoot, { recursive: true, force: true })
  }
}

test("a path-only document is accepted from the folder attachments are kept in", async () => {
  await withTempWorkspace(async (workspaceRoot, uploadsDir) => {
    const filePath = path.join(uploadsDir, "already-there.txt")
    await writeFile(filePath, "the bytes stay where they are")
    const result = await process(document({ path: filePath, filename: "already-there.txt" }), { workspaceRoot })
    assert.equal(result.docData, undefined)
    assert.equal(result.documentFilePath !== undefined, true)
    assert.equal(result.selectedDocument?.path, result.documentFilePath)
  })
})

test("a path-only document from anywhere else is refused", async () => {
  await withTempWorkspace(async (workspaceRoot, uploadsDir) => {
    const outsidePath = path.join(workspaceRoot, "secrets.txt")
    await writeFile(outsidePath, "not an attachment")
    const result = await process(document({ path: outsidePath, filename: "secrets.txt" }), { workspaceRoot })
    assert.equal(result.docData, undefined)
    assert.equal(result.documentFilePath, undefined)
    assert.equal(result.selectedDocument, undefined)
    // The folder itself is trusted only for what is inside it.
    assert.equal(uploadsDir.length > 0, true)
  })
})

test("a path-only document that does not exist is refused rather than treated as trusted", async () => {
  await withTempWorkspace(async (workspaceRoot, uploadsDir) => {
    const result = await process(document({ path: path.join(uploadsDir, "never-written.txt") }), { workspaceRoot })
    assert.equal(result.documentFilePath, undefined)
    assert.equal(result.selectedDocument, undefined)
  })
})

test("a path-only document with no trusted environment at all is refused", async () => {
  await withTempWorkspace(async (_workspaceRoot, uploadsDir) => {
    const filePath = path.join(uploadsDir, "there.txt")
    await writeFile(filePath, "bytes")
    const result = await process(document({ path: filePath }))
    assert.equal(result.documentFilePath, undefined)
    assert.equal(result.selectedDocument, undefined)
  })
})
