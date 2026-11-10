import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createContext } from "../../source/packages/context/context.ts"
import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { AskQuestionResult } from "../../source/adapters/interop/proto/generated/agent/v1/ask_question_tool_pb.ts"
import {
  SelectedGitPRDiffSelection,
  SelectedImage,
  SelectedImage_Dimension,
  SelectedImage_BlobIdWithData,
  SelectedPullRequest,
  SelectedVideo,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { PromptUploadRef } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  attachToolReferenceHints,
  shouldExposeToolReferencesInCurrentContext,
} from "../../source/packages/agent/tools/tool-call-id-tagging.ts"
import { calculateDiff } from "../../source/packages/agent/tools/core/edit/diff-worker.ts"
import {
  hydrateGitPrDiffSelections,
  hydrateSelectedPullRequests,
  fromInteropSelectedPullRequest,
  fromInteropSelectedPullRequestDiff,
} from "../../source/adapters/interop/agent/pull-request-hydration-adapter.ts"
import {
  GENERAL_PURPOSE_SUBAGENT_TYPE,
  normalizeSubagentTypeName,
} from "../../source/packages/agent/tools/core/subagent/subagent-config.ts"
import {
  isVideoReviewSubagentType,
  mapSubagentConversationState,
  subagentTypeNameFromInterop,
} from "../../source/adapters/interop/agent/subagent-type-adapter.ts"
import { hydrateSelectedExtraContext } from "../../source/packages/agent/context/extra-context-hydration.ts"
import { hydrateSelectedImageData } from "../../source/adapters/interop/agent/selected-image-blob-adapter.ts"
import { fromInteropSelectedImage, toInteropSelectedImage } from "../../source/adapters/interop/agent/selected-context-entry-adapter.ts"
import {
  canonicalSubagentModelId,
  isBuiltInSubagentModelId,
  isSubagentDefaultId,
  normalizeTaskArgModelInput,
  orderedExploreSubagentModelIds,
  resolveTaskArgToSubagentModelId,
  shouldNormalizeTaskArgModelInput,
  taskArgSelectsFastSubagentTier,
} from "../../source/packages/agent/tools/subagent-model-resolution.ts"
import { resolveTrustedPathOnlyAttachmentPath } from "../../source/packages/agent/context/path-trust.ts"
import { processSelectedVideoPathOnly } from "../../source/adapters/interop/agent/selected-video-path-adapter.ts"
import { extractCellSource, isJupyterNotebook, parseNotebook, tryParseNotebook } from "../../source/packages/agent/tools/core/notebook-utils.ts"
import { formatNotebookForLLM } from "../../source/packages/agent/tools/core/read/notebook-format.ts"
import {
  formatAskQuestionResultAsString,
  shouldReceiptAskQuestionResult,
} from "../../source/packages/agent/tools/core/ask-question/index.ts"
import { hydrateAttachmentContent } from "../../source/packages/agent/context/attachment-hydration.ts"
import {
  buildRequestContextNotesOptions,
  buildRequestContextOptions,
  isMetaAgentNotesEnabled,
} from "../../source/packages/agent/actions/meta-agent-notes.ts"
import { buildUserInfoAgentNotesProps } from "../../source/adapters/interop/agent/meta-agent-notes-adapter.ts"
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"

const ctx = () => createContext()

// ---------------------------------------------------------------------------------------------
// tagging tool results with their call's reference
// ---------------------------------------------------------------------------------------------

test("a tool result gets its call's reference appended once", () => {
  const messages = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call_abcdefg", result: "output" }] }]
  attachToolReferenceHints(messages as never)
  const part = (messages[0]!.content as Array<{ result: string }>)[0]!
  assert.match(part.result, /^output\n<tool_call_id>abcdefg<\/tool_call_id>$/)

  attachToolReferenceHints(messages as never)
  assert.equal(part.result.match(/<tool_call_id>/g)?.length, 1)
})

test("a result with no text takes the tag as its whole result", () => {
  const messages = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call_abcdefg" }] }]
  attachToolReferenceHints(messages as never)
  const part = (messages[0]!.content as unknown as Array<{ result: string }>)[0]!
  assert.equal(part.result, "<tool_call_id>abcdefg</tool_call_id>")
})

test("a result with content parts gets the tag on its last text part", () => {
  const messages = [{
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "call_abcdefg",
      result: "text",
      experimental_content: [{ type: "text", text: "one" }, { type: "image" }],
    }],
  }]
  attachToolReferenceHints(messages as never)
  const part = (messages[0]!.content as Array<{ experimental_content: Array<{ type?: string; text?: string }> }>)[0]!
  assert.match(String(part.experimental_content[0]!.text), /one\n<tool_call_id>abcdefg/)
  assert.equal(part.experimental_content.length, 2)
})

test("a result with no text part at all gets one", () => {
  const messages = [{
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_abcdefg", experimental_content: [{ type: "image" }] }],
  }]
  attachToolReferenceHints(messages as never)
  const part = (messages[0]!.content as Array<{ experimental_content: Array<{ type?: string; text?: string }> }>)[0]!
  assert.deepEqual(part.experimental_content[1], { type: "text", text: "<tool_call_id>abcdefg</tool_call_id>" })
})

test("a call whose id carries no reference is left alone, and non-tool messages are skipped", () => {
  const messages = [
    { role: "tool", content: [{ type: "tool-result", toolCallId: "ab", result: "x" }] },
    { role: "assistant", content: [{ type: "tool-result", toolCallId: "call_abcdefg", result: "x" }] },
    { role: "tool", content: "not an array" },
  ]
  attachToolReferenceHints(messages as never)
  assert.equal((messages[0]!.content as Array<{ result: string }>)[0]!.result, "x")
  assert.equal((messages[1]!.content as Array<{ result: string }>)[0]!.result, "x")
})

test("tagging is asked of the context", () => {
  assert.equal(typeof shouldExposeToolReferencesInCurrentContext(ctx()), "boolean")
})

// ---------------------------------------------------------------------------------------------
// the diff a write produced
// ---------------------------------------------------------------------------------------------

test("a modification is rendered as a git diff with its counts", () => {
  const result = calculateDiff({ original: "a\nb\n", new: "a\nc\n", filePath: "src/a.ts" })
  assert.match(result.diffString, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts/)
  assert.match(result.diffString, /@@ -1,2 \+1,2 @@/)
  assert.equal(result.linesAdded, 1)
  assert.equal(result.linesRemoved, 1)
})

test("an added file and a deleted one are named against /dev/null", () => {
  const added = calculateDiff({ original: "", new: "x\n", filePath: "a.ts", fileChangeType: "added" })
  assert.match(added.diffString, /^--- \/dev\/null\n\+\+\+ b\/a\.ts/)
  const deleted = calculateDiff({ original: "x\n", new: "", filePath: "a.ts", fileChangeType: "deleted" })
  assert.match(deleted.diffString, /^--- a\/a\.ts\n\+\+\+ \/dev\/null/)
})

test("no change means no diff", () => {
  const result = calculateDiff({ original: "same\n", new: "same\n" })
  assert.equal(result.diffString, "")
  assert.equal(result.linesAdded, 0)
  assert.equal(result.linesRemoved, 0)
})

test("a missing trailing newline does not become a change of its own", () => {
  assert.equal(calculateDiff({ original: "a", new: "a\n" }).diffString, "")
})

test("a missing file name falls back to a placeholder", () => {
  assert.match(calculateDiff({ original: "a\n", new: "b\n" }).diffString, /^--- a\/file/)
  assert.match(calculateDiff({ original: "a\n", new: "b\n", filePath: "   " }).diffString, /^--- a\/file/)
})

// ---------------------------------------------------------------------------------------------
// hydrating pull requests
// ---------------------------------------------------------------------------------------------

test("an attached pull request is left alone unless it names a blob", async () => {
  const inlinePullRequest = { number: 7, url: "https://code.example/pull/7", localReviewDirectory: "/workspace/review-7", blobId: new Uint8Array(0) }
  const inlineDiff = { url: "https://code.example/pull/7", filePath: "src/a.ts", startLine: 1, endLine: 2, blobId: new Uint8Array(0) }
  assert.deepEqual(await hydrateSelectedPullRequests({ ctx: ctx(), selectedPullRequests: [inlinePullRequest] }), [inlinePullRequest])
  assert.deepEqual(await hydrateGitPrDiffSelections({ ctx: ctx(), gitPrDiffSelections: [inlineDiff] }), [inlineDiff])
})

test("a pull request blob is fetched, and both failures are thrown", async () => {
  const pullRequestWithBlob = { number: 7, url: "https://code.example/pull/7", localReviewDirectory: "/workspace/review-7", blobId: new Uint8Array([1, 2]) }
  const diffWithBlob = { url: "https://code.example/pull/7", filePath: "src/a.ts", startLine: 1, endLine: 2, blobId: new Uint8Array([1, 2]) }
  await assert.rejects(
    hydrateSelectedPullRequests({ ctx: ctx(), selectedPullRequests: [pullRequestWithBlob] }),
    /Blob store is required/,
  )
  await assert.rejects(
    hydrateGitPrDiffSelections({ ctx: ctx(), gitPrDiffSelections: [diffWithBlob] }),
    /Blob store is required/,
  )
  await assert.rejects(
    hydrateSelectedPullRequests({
      ctx: ctx(),
      selectedPullRequests: [pullRequestWithBlob],
      blobStore: { getBlob: async () => undefined },
    }),
    /pull request blob not found/,
  )
  await assert.rejects(
    hydrateGitPrDiffSelections({
      ctx: ctx(),
      gitPrDiffSelections: [diffWithBlob],
      blobStore: { getBlob: async () => undefined },
    }),
    /diff selection blob not found/,
  )
})

test("pull requests and diff selections are decoded from their stored messages", async () => {
  const pullRequest = new SelectedPullRequest({
    number: 42,
    url: "https://code.example/pull/42",
    folderPath: "workspace/pull-42",
    description: "Review the implementation",
  })
  const diffSelection = new SelectedGitPRDiffSelection({
    prUrl: "https://code.example/pull/42",
    filePath: "src/main.ts",
    startLine: 4,
    endLine: 8,
    diffContent: "-old\n+new",
  })
  const stored = new Map([
    ["01", pullRequest.toBinary()],
    ["02", diffSelection.toBinary()],
  ])
  const blobStore = {
    async getBlob(_ctx: unknown, blobId: Uint8Array) {
      return stored.get(Buffer.from(blobId).toString("hex"))
    },
  }

  const hydratedPullRequests = await hydrateSelectedPullRequests({
    ctx: ctx(),
    selectedPullRequests: [fromInteropSelectedPullRequest(new SelectedPullRequest({ blobId: new Uint8Array([1]) }))],
    blobStore,
  })
  const hydratedDiffs = await hydrateGitPrDiffSelections({
    ctx: ctx(),
    gitPrDiffSelections: [fromInteropSelectedPullRequestDiff(new SelectedGitPRDiffSelection({ blobId: new Uint8Array([2]) }))],
    blobStore,
  })

  assert.deepEqual(hydratedPullRequests[0], fromInteropSelectedPullRequest(pullRequest))
  assert.deepEqual(hydratedDiffs[0], fromInteropSelectedPullRequestDiff(diffSelection))
})

// ---------------------------------------------------------------------------------------------
// subagent types
// ---------------------------------------------------------------------------------------------

test("a subagent type name is normalized whatever the caller wrote", () => {
  assert.equal(normalizeSubagentTypeName("GeneralPurpose"), "generalpurpose")
  assert.equal(normalizeSubagentTypeName("general-purpose-subagent"), "generalpurpose")
  assert.equal(normalizeSubagentTypeName("explore_subagent_type"), "explore")
  assert.equal(normalizeSubagentTypeName("mediaReview"), "videoreview")
  assert.equal(normalizeSubagentTypeName("  Debug  "), "debug")
})

test("a type message becomes the name the platform uses", () => {
  assert.equal(subagentTypeNameFromInterop({ type: { case: "unspecified" } } as never), GENERAL_PURPOSE_SUBAGENT_TYPE)
  assert.equal(subagentTypeNameFromInterop({ type: { case: "custom", value: { name: "mine" } } } as never), "mine")
  assert.equal(subagentTypeNameFromInterop({ type: { case: "bash" } } as never), "shell")
  assert.equal(subagentTypeNameFromInterop({ type: { case: "shell" } } as never), "shell")
  assert.equal(subagentTypeNameFromInterop({ type: { case: "browserUse" } } as never), "browser-use")
  assert.equal(subagentTypeNameFromInterop({ type: { case: "mediaReview" } } as never), "videoReview")
  assert.equal(subagentTypeNameFromInterop({ type: { case: "cursorGuide" } } as never), "guide")
})

test("the media-watching types are one family", () => {
  assert.equal(isVideoReviewSubagentType({ type: { case: "mediaReview" } } as never), true)
  assert.equal(isVideoReviewSubagentType({ type: { case: "watchVideo" } } as never), true)
  assert.equal(isVideoReviewSubagentType({ type: { case: "explore" } } as never), false)
  assert.equal(isVideoReviewSubagentType(undefined), false)
})

test("a subagent with no mapping starts from an empty structure, and one with a mapping is mapped", () => {
  const callerState = new ConversationStateStructure()
  assert.notEqual(mapSubagentConversationState({}, callerState), callerState)

  const mapped = new ConversationStateStructure()
  assert.equal(mapSubagentConversationState({ conversationStateMapper: () => mapped }, callerState), mapped)
})

// ---------------------------------------------------------------------------------------------
// extra context
// ---------------------------------------------------------------------------------------------

test("extra context is collected and deduplicated, blobs included", async () => {
  const result = await hydrateSelectedExtraContext(ctx(), {
    entries: [
      { kind: "inline-text", text: "inline" },
      { kind: "stored-text", blobId: new Uint8Array([1]) },
      { kind: "empty" },
    ],
    inlineText: ["inline", "another"],
  }, { getBlob: async () => new TextEncoder().encode("from blob") })
  assert.deepEqual(result, ["inline", "from blob", "another"])
})

test("a missing extra-context blob is an error, and an empty value is not context", async () => {
  await assert.rejects(
    hydrateSelectedExtraContext(ctx(), {
      entries: [{ kind: "stored-text", blobId: new Uint8Array([1]) }],
      inlineText: [],
    }, undefined),
    /Blob store is required/,
  )
  await assert.rejects(
    hydrateSelectedExtraContext(ctx(), {
      entries: [{ kind: "stored-text", blobId: new Uint8Array([1]) }],
      inlineText: [],
    }, { getBlob: async () => undefined }),
    /blob not found/,
  )
  assert.deepEqual(await hydrateSelectedExtraContext(ctx(), {
    entries: [],
    inlineText: ["", "kept"],
  }, undefined), ["kept"])
})

// ---------------------------------------------------------------------------------------------
// image data
// ---------------------------------------------------------------------------------------------

function blobStoreSpy(): {
  store: {
    getBlob: (ctx: unknown, blobId: Uint8Array) => Promise<Uint8Array | undefined>
    setBlob: (ctx: unknown, blobId: Uint8Array, data: Uint8Array) => Promise<void>
    setBlobLocallyOnly: (ctx: unknown, blobId: Uint8Array, data: Uint8Array) => Promise<void>
  }
  calls: string[]
  blobs: Map<string, Uint8Array>
} {
  const calls: string[] = []
  const blobs = new Map<string, Uint8Array>()
  return {
    calls,
    blobs,
    store: {
      async getBlob(_ctx, blobId) {
        calls.push("get")
        return blobs.get(String(blobId))
      },
      async setBlob(_ctx, blobId, data) {
        calls.push("set")
        blobs.set(String(blobId), data)
      },
      async setBlobLocallyOnly(_ctx, blobId, data) {
        calls.push("setLocal")
        blobs.set(String(blobId), data)
      },
    },
  }
}

test("image bytes that arrived alone are stored and become a reference", async () => {
  const spy = blobStoreSpy()
  const result = await hydrateSelectedImageData({
    ctx: ctx(),
    blobStore: spy.store as never,
    selectedImage: { dataOrBlobId: { case: "data", value: new Uint8Array([1, 2, 3]) } } as never,
  })
  assert.deepEqual(spy.calls, ["set"])
  assert.equal(result.selectedImage?.dataOrBlobId?.case, "blobId")
  assert.deepEqual(result.imageData, new Uint8Array([1, 2, 3]))
  const payload = result.selectedImage?.dataOrBlobId
  const blobId = payload?.case === "blobId" ? payload.value : undefined
  assert.ok(blobId)
  assert.deepEqual(spy.blobs.get(String(blobId)), new Uint8Array([1, 2, 3]))
})

test("image bytes that came with an id are stored locally only", async () => {
  const spy = blobStoreSpy()
  const result = await hydrateSelectedImageData({
    ctx: ctx(),
    blobStore: spy.store as never,
    selectedImage: {
      dataOrBlobId: { case: "blobIdWithData", value: { blobId: new Uint8Array([9]), data: new Uint8Array([1]) } },
    } as never,
  })
  assert.deepEqual(spy.calls, ["setLocal"])
  assert.equal(result.selectedImage?.dataOrBlobId?.case, "blobId")
  if (result.selectedImage?.dataOrBlobId?.case === "blobId") {
    assert.deepEqual(result.selectedImage.dataOrBlobId.value, new Uint8Array([9]))
  }
  assert.deepEqual(spy.blobs.get(String(new Uint8Array([9]))), new Uint8Array([1]))
})

test("a reference is fetched, a missing one is an error, and an unresolved upload is an error", async () => {
  const spy = blobStoreSpy()
  spy.blobs.set(String(new Uint8Array([7])), new Uint8Array([4, 5]))
  const fetched = await hydrateSelectedImageData({
    ctx: ctx(),
    blobStore: spy.store as never,
    selectedImage: { dataOrBlobId: { case: "blobId", value: new Uint8Array([7]) } } as never,
  })
  assert.deepEqual(fetched.imageData, new Uint8Array([4, 5]))
  assert.equal(fetched.selectedImage?.dataOrBlobId?.case, "blobId")

  await assert.rejects(
    hydrateSelectedImageData({
      ctx: ctx(),
      blobStore: spy.store as never,
      selectedImage: { dataOrBlobId: { case: "blobId", value: new Uint8Array([8]) } } as never,
    }),
    /Image not found/,
  )
  await assert.rejects(
    hydrateSelectedImageData({
      ctx: ctx(),
      blobStore: spy.store as never,
      selectedImage: { dataOrBlobId: { case: "promptUploadRef", value: {} } } as never,
    }),
    /unresolved prompt upload/,
  )
})

test("an image with nothing in it produces nothing", async () => {
  const spy = blobStoreSpy()
  const result = await hydrateSelectedImageData({
    ctx: ctx(),
    blobStore: spy.store as never,
    selectedImage: {} as never,
  })
  assert.deepEqual(spy.calls, [])
  assert.equal(result.imageData, undefined)
  assert.equal(result.selectedImage, undefined)
})

test("selected image variants use a Slate record and reconstruct the same attachment", () => {
  const images = [
    new SelectedImage({
      uuid: "image-1",
      path: "/repo/one.png",
      mimeType: "image/png",
      dimension: new SelectedImage_Dimension({ width: 640, height: 480 }),
      dataOrBlobId: { case: "data", value: new Uint8Array([1, 2]) },
    }),
    new SelectedImage({ uuid: "image-2", path: "/repo/two.png", dataOrBlobId: { case: "blobId", value: new Uint8Array([3]) } }),
    new SelectedImage({ uuid: "image-3", path: "/repo/three.png", dataOrBlobId: {
      case: "blobIdWithData", value: new SelectedImage_BlobIdWithData({ blobId: new Uint8Array([4]), data: new Uint8Array([5]) }),
    } }),
    new SelectedImage({ uuid: "image-4", path: "/repo/four.png", dataOrBlobId: {
      case: "promptUploadRef", value: new PromptUploadRef({ uploadId: "upload-4" }),
    } }),
  ]

  const slate = images.map(fromInteropSelectedImage)
  assert.deepEqual(slate[0], {
    id: "image-1",
    sourcePath: "/repo/one.png",
    mediaType: "image/png",
    dimensions: { width: 640, height: 480 },
    content: { kind: "inline-bytes", bytes: new Uint8Array([1, 2]) },
  })
  assert.deepEqual(slate.map(image => image.content?.kind), ["inline-bytes", "stored-blob", "blob-with-bytes", "unresolved-upload"])
  assert.equal(slate[3]?.content?.kind === "unresolved-upload" ? slate[3].content.uploadId : undefined, "upload-4")
  for (let index = 0; index < images.length; index += 1) {
    assert.ok(SelectedImage.equals(toInteropSelectedImage(slate[index]!), images[index]))
  }
  const payload = images[0]!.dataOrBlobId
  if (payload.case !== "data") assert.fail("expected inline image data")
  payload.value[0] = 9
  const slatePayload = slate[0]!.content
  if (slatePayload?.kind !== "inline-bytes") assert.fail("expected Slate inline image data")
  assert.deepEqual(slatePayload.bytes, new Uint8Array([1, 2]), "Slate owns a detached byte copy")
})

// ---------------------------------------------------------------------------------------------
// subagent model resolution
// ---------------------------------------------------------------------------------------------

test("a retired subagent model id is mapped to its replacement", () => {
  assert.equal(canonicalSubagentModelId("composer-1.5"), "composer-2.5")
  assert.equal(canonicalSubagentModelId("composer-2.5"), "composer-2.5")
  assert.equal(isBuiltInSubagentModelId("composer-1.5"), true)
  assert.equal(isBuiltInSubagentModelId("gpt-5"), false)
  assert.equal(isSubagentDefaultId("composer-2.5-fast"), true)
})

test("the cheaper subagent model tier is offered first when it costs less than the parent", () => {
  const ids = ["composer-2.5-fast", "composer-2.5", "extra"]
  assert.deepEqual(orderedExploreSubagentModelIds(ids, "parent", () => 1), ["composer-2.5", "composer-2.5-fast", "extra"])
  assert.deepEqual(orderedExploreSubagentModelIds(ids, "parent", () => -1), ids)
  assert.deepEqual(orderedExploreSubagentModelIds(["one"], "parent", () => 1), ["one"])
})

test("a model request is normalized only when the catalogue would survive it", () => {
  const clean = new Map([["composer-2.5", { slug: "composer-2.5" }]])
  const mixed = new Map([["Composer-2.5", { slug: "Composer-2.5" }]])
  assert.equal(shouldNormalizeTaskArgModelInput(clean), true)
  assert.equal(shouldNormalizeTaskArgModelInput(mixed), false)
  assert.equal(normalizeTaskArgModelInput("  Composer_2_5  ", clean), "composer-2-5")
  assert.equal(normalizeTaskArgModelInput("  Composer_2_5  ", mixed), "Composer_2_5")
})

test("a request resolves through the catalog and the two subagent-tier aliases", () => {
  const models = new Map([["composer-2.5", { slug: "composer-2.5" }]])
  assert.equal(resolveTaskArgToSubagentModelId("composer-2.5", models), "composer-2.5")
  // The legacy slug is only mapped when the catalogue still carries it under that name.
  assert.equal(resolveTaskArgToSubagentModelId("composer-1.5", models), undefined)
  assert.equal(
    resolveTaskArgToSubagentModelId("composer-1.5", new Map([["composer-1.5", { slug: "composer-1.5" }]])),
    "composer-2.5",
  )
  assert.equal(resolveTaskArgToSubagentModelId("something-fast", models), "composer-2.5-fast")
  assert.equal(resolveTaskArgToSubagentModelId("default", models), "composer-2.5")
  assert.equal(resolveTaskArgToSubagentModelId("AUTO", models), "composer-2.5")
  assert.equal(resolveTaskArgToSubagentModelId("nonsense", models), undefined)
  assert.equal(taskArgSelectsFastSubagentTier(" X-Fast "), true)
  assert.equal(taskArgSelectsFastSubagentTier("fast"), false)
})

// ---------------------------------------------------------------------------------------------
// path trust and path-only video
// ---------------------------------------------------------------------------------------------

/** The canonical path, since a document path is compared after resolution and a temp dir is a symlink. */
async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "slate-path-trust-"))
  return await realpath(directory)
}

test("a document path is trusted only under an attachment location", async () => {
  const root = await makeWorkspace()
  try {
    const uploads = path.join(root, "uploads")
    await mkdir(uploads, { recursive: true })
    const inside = path.join(uploads, "a.pdf")
    await writeFile(inside, "x")
    const outside = path.join(root, "a.pdf")
    await writeFile(outside, "x")

    const requestContext = { env: { projectFolder: root, workspacePaths: [root] } }
    const trusted = await resolveTrustedPathOnlyAttachmentPath(ctx(), inside, requestContext, "document", true)
    assert.equal(trusted.hasPathOnlyPayload, true)
    assert.equal(trusted.trustedPath, inside)

    const untrusted = await resolveTrustedPathOnlyAttachmentPath(ctx(), outside, requestContext, "document", true)
    assert.equal(untrusted.hasPathOnlyPayload, true)
    assert.equal(untrusted.trustedPath, undefined)

    const missing = await resolveTrustedPathOnlyAttachmentPath(ctx(), path.join(uploads, "nope.pdf"), requestContext, "document", true)
    assert.equal(missing.trustedPath, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("attachment storage under the project is trusted, and a symlink out of it is not", async () => {
  const root = await makeWorkspace()
  try {
    const storage = path.join(root, "attachments", "video")
    await mkdir(storage, { recursive: true })
    const stored = path.join(storage, "v.mp4")
    await writeFile(stored, "x")
    const requestContext = { env: { projectFolder: root, workspacePaths: [root] } }
    const trusted = await resolveTrustedPathOnlyAttachmentPath(ctx(), stored, requestContext, "document", true)
    assert.equal(trusted.trustedPath, stored)

    const secret = path.join(root, "secret.txt")
    await writeFile(secret, "x")
    const link = path.join(storage, "link.txt")
    await symlink(secret, link)
    const escaped = await resolveTrustedPathOnlyAttachmentPath(ctx(), link, requestContext, "document", true)
    assert.equal(escaped.trustedPath, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a video path is taken as given, since the platform produced it", async () => {
  const root = await makeWorkspace()
  try {
    const videoPath = path.join(root, "v.mp4")
    const trusted = await resolveTrustedPathOnlyAttachmentPath(ctx(), videoPath, undefined, "video", true)
    assert.equal(trusted.trustedPath, videoPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a relative path is only path-only when the caller says so", async () => {
  assert.equal(
    (await resolveTrustedPathOnlyAttachmentPath(ctx(), "relative.mp4", undefined, "video", false)).hasPathOnlyPayload,
    false,
  )
  assert.equal(
    (await resolveTrustedPathOnlyAttachmentPath(ctx(), "relative.mp4", undefined, "video", true)).hasPathOnlyPayload,
    true,
  )
  assert.equal(
    (await resolveTrustedPathOnlyAttachmentPath(ctx(), "", undefined, "video", true)).hasPathOnlyPayload,
    false,
  )
})

test("a path-only video comes back with its trusted path and its name", async () => {
  const video = new SelectedVideo({
    path: "/tmp/attached/v.mp4",
    filename: "",
    mimeType: "video/mp4",
    fps: 2,
  } as never)
  const processed = await processSelectedVideoPathOnly({ ctx: ctx(), selectedVideo: video, requestContext: undefined })
  assert.equal(processed?.localFilePath, "/tmp/attached/v.mp4")
  assert.equal(processed?.filename, "v.mp4")
  assert.equal(processed?.fps, 2)
  assert.equal(processed?.videoData, undefined)
})

test("a video with a non-video mime type is refused", async () => {
  const video = new SelectedVideo({ path: "/tmp/v.mp4", mimeType: "text/plain" } as never)
  await assert.rejects(
    processSelectedVideoPathOnly({ ctx: ctx(), selectedVideo: video, requestContext: undefined }),
    /require a video\/\* mime type/,
  )
})

test("a video that is not path-only is not processed here", async () => {
  const video = new SelectedVideo({ dataOrBlobId: { case: "blobId", value: new Uint8Array([1]) } } as never)
  assert.equal(
    await processSelectedVideoPathOnly({ ctx: ctx(), selectedVideo: video, requestContext: undefined }),
    undefined,
  )
})

// ---------------------------------------------------------------------------------------------
// notebooks
// ---------------------------------------------------------------------------------------------

const SAMPLE_NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Title\n", "text"] },
    { cell_type: "code", source: "print(1)", outputs: [{ output_type: "stream", text: ["1\n"] }] },
  ],
  metadata: {},
  nbformat: 4,
})

test("a notebook is parsed and its cells extracted", () => {
  const parsed = parseNotebook(SAMPLE_NOTEBOOK)
  assert.equal(parsed.success, true)
  const notebook = tryParseNotebook(SAMPLE_NOTEBOOK)!
  assert.equal(notebook.cells.length, 2)
  assert.equal(extractCellSource(notebook.cells[0]!), "# Title\ntext")
  assert.equal(extractCellSource(notebook.cells[1]!), "print(1)")
  assert.equal(isJupyterNotebook("/w/a.ipynb"), true)
  assert.equal(isJupyterNotebook("/w/a.py"), false)
})

test("a notebook that is not JSON, or not the right shape, says what was wrong", () => {
  const notJson = parseNotebook("{not json")
  assert.equal(notJson.success, false)
  assert.equal((notJson as { error: string }).error, "Failed to parse notebook as JSON")

  const wrongShape = parseNotebook(JSON.stringify({ cells: [{ cell_type: "code" }] }))
  assert.equal(wrongShape.success, false)
  assert.match((wrongShape as { error: string }).error, /^Invalid notebook structure: cells\.0\.source/)
  assert.equal(tryParseNotebook("{not json"), undefined)
})

test("a notebook is written out with its cells and their outputs", () => {
  const formatted = formatNotebookForLLM(SAMPLE_NOTEBOOK)
  assert.match(formatted, /Cell 0:/)
  assert.match(formatted, /# Title\ntext/)
  assert.match(formatted, /Cell 1 output:/)
  assert.match(formatted, /1\n/)
})

test("an error traceback loses its colour codes, and a long output is capped", () => {
  const escape = String.fromCharCode(27)
  const withError = JSON.stringify({
    cells: [{ cell_type: "code", source: "boom", outputs: [{ output_type: "error", traceback: [`${escape}[31mError${escape}[0m`] }] }],
  })
  assert.match(formatNotebookForLLM(withError), /Error/)
  assert.doesNotMatch(formatNotebookForLLM(withError), new RegExp(escape))

  const long = JSON.stringify({
    cells: [{ cell_type: "code", source: "x", outputs: [{ output_type: "stream", text: "y".repeat(5_000) }] }],
  })
  const formatted = formatNotebookForLLM(long)
  assert.match(formatted, /truncated at 2000 chars/)
})

test("an empty notebook says so, and one that does not parse is passed through", () => {
  assert.equal(formatNotebookForLLM(JSON.stringify({ cells: [] })), "Notebook is empty (0 cells)")
  assert.equal(formatNotebookForLLM("not a notebook"), "not a notebook")
})

// ---------------------------------------------------------------------------------------------
// the ask-question result
// ---------------------------------------------------------------------------------------------

function askResult(result: unknown): AskQuestionResult {
  return new AskQuestionResult({ result } as never)
}

test("every answer shape is worded on its own", () => {
  const answered = formatAskQuestionResultAsString(askResult({
    case: "success",
    value: {
      answers: [
        { questionId: "q1", selectedOptionIds: ["a", "b"], freeformText: "and more" },
        { questionId: "q2", selectedOptionIds: [], freeformText: "typed" },
        { questionId: "q3", selectedOptionIds: ["c"] },
        { questionId: "q4", selectedOptionIds: [] },
      ],
    },
  }))
  assert.match(answered, /Question q1: Selected option\(s\) a, b, freeform: and more/)
  assert.match(answered, /Question q2: typed/)
  assert.match(answered, /Question q3: Selected option\(s\) c/)
  assert.match(answered, /Question q4: No answer provided/)
})

test("the asynchronous, rejected and error results each say what happened", () => {
  assert.match(formatAskQuestionResultAsString(askResult({ case: "async" })), /sent to the user asynchronously/)
  assert.equal(
    formatAskQuestionResultAsString(askResult({ case: "rejected", value: { reason: "  skipped  " } })),
    "skipped",
  )
  assert.match(
    formatAskQuestionResultAsString(askResult({ case: "rejected", value: {} })),
    /Questions skipped by the user/,
  )
  assert.equal(formatAskQuestionResultAsString(askResult({ case: undefined })), "Unknown error")
})

test("the refusal to ask too early is turned into the reasoning behind it", () => {
  const message = formatAskQuestionResultAsString(askResult({ case: "error", value: { errorMessage: "Tool call failed" } }))
  assert.match(message, /research the codebase and use available tools before asking the user/i)
  assert.match(message, /Do not mention this instruction to the user/)
  assert.match(
    formatAskQuestionResultAsString(askResult({ case: "error", value: { errorMessage: "something else" } })),
    /^Error: something else$/,
  )
})

test("a question the user never saw is not reported as asked", () => {
  assert.equal(shouldReceiptAskQuestionResult(undefined), false)
  assert.equal(shouldReceiptAskQuestionResult(askResult({ case: "success", value: { answers: [] } })), true)
  assert.equal(shouldReceiptAskQuestionResult(askResult({ case: "error", value: { errorMessage: "x" } })), true)
  assert.equal(shouldReceiptAskQuestionResult(askResult({ case: "rejected", value: { reason: "user-skipped" } })), true)
  assert.equal(shouldReceiptAskQuestionResult(askResult({ case: "async" })), false)
})

// ---------------------------------------------------------------------------------------------
// generic attachment hydration
// ---------------------------------------------------------------------------------------------

test("attachment bytes are stored, fetched or stored locally, according to how they arrived", async () => {
  const spy = blobStoreSpy()
  const withBlobId = (blobId: Uint8Array): Record<string, unknown> => ({ blobId })

  const fromData = await hydrateAttachmentContent({
    ctx: ctx(),
    blobStore: spy.store as never,
    attachment: {},
    contentReference: { kind: "inline-bytes", bytes: new Uint8Array([1, 2]) },
    missingBlobError: "gone",
    sizeErrorLabel: "Document",
    withBlobId,
  })
  assert.equal((fromData.attachment?.blobId as Uint8Array).length, 32)
  assert.deepEqual(spy.calls, ["set"])

  const fromBlob = await hydrateAttachmentContent({
    ctx: ctx(),
    blobStore: spy.store as never,
    attachment: {},
    contentReference: { kind: "stored-blob", blobId: fromData.attachment!.blobId as Uint8Array },
    missingBlobError: "gone",
    sizeErrorLabel: "Document",
    withBlobId,
  })
  assert.deepEqual(fromBlob.data, new Uint8Array([1, 2]))
  assert.deepEqual(fromBlob.attachment, {})
})

test("an oversized attachment is refused before anything is written", async () => {
  const spy = blobStoreSpy()
  await assert.rejects(
    hydrateAttachmentContent({
      ctx: ctx(),
      blobStore: spy.store as never,
      attachment: {},
      contentReference: { kind: "inline-bytes", bytes: new Uint8Array(11) },
      missingBlobError: "gone",
      maxBytes: 10,
      sizeErrorLabel: "Video",
      withBlobId: (blobId: Uint8Array): Record<string, unknown> => ({ blobId }),
    }),
    /Video exceeds maximum size of 10 bytes \(0MB\)/,
  )
  assert.deepEqual(spy.calls, [])
})

test("a missing blob and an unresolved upload are both errors, and nothing at all is not", async () => {
  const spy = blobStoreSpy()
  await assert.rejects(
    hydrateAttachmentContent({
      ctx: ctx(),
      blobStore: spy.store as never,
      attachment: {},
      contentReference: { kind: "stored-blob", blobId: new Uint8Array([1]) },
      missingBlobError: "gone",
      sizeErrorLabel: "Document",
      withBlobId: (blobId: Uint8Array): Record<string, unknown> => ({ blobId }),
    }),
    /gone/,
  )
  await assert.rejects(
    hydrateAttachmentContent({
      ctx: ctx(),
      blobStore: spy.store as never,
      attachment: {},
      contentReference: { kind: "unresolved-upload-reference", uploadId: "upload-1" },
      missingBlobError: "gone",
      sizeErrorLabel: "Document",
      withBlobId: (blobId: Uint8Array): Record<string, unknown> => ({ blobId }),
    }),
    /unresolved prompt upload/,
  )
  assert.deepEqual(
    await hydrateAttachmentContent({
      ctx: ctx(),
      blobStore: spy.store as never,
      attachment: {},
      contentReference: undefined,
      missingBlobError: "gone",
      sizeErrorLabel: "Document",
      withBlobId: (blobId: Uint8Array): Record<string, unknown> => ({ blobId }),
    }),
    { data: undefined, attachment: undefined },
  )
})

// ---------------------------------------------------------------------------------------------
// meta-agent notes options
// ---------------------------------------------------------------------------------------------

test("the notes session is the one given, or the conversation's", () => {
  assert.deepEqual(buildRequestContextNotesOptions({ notesSessionId: "s" }), {
    notesSessionId: "s",
    metaAgentNotesEnabled: false,
  })
  assert.deepEqual(buildRequestContextNotesOptions({ conversationId: "c" }), {
    notesSessionId: "c",
    metaAgentNotesEnabled: false,
  })
  assert.equal(isMetaAgentNotesEnabled({ metaAgentNotes: true }), true)
  assert.equal(isMetaAgentNotesEnabled({ metaAgentNotes: false }), false)
  assert.equal(isMetaAgentNotesEnabled(null), false)
  assert.equal(isMetaAgentNotesEnabled("nope"), false)
})

test("the actor travels with the request-context options", () => {
  const options = buildRequestContextOptions({ notesSessionId: "s", actorIdentity: { email: "me@x.test" } })
  assert.deepEqual(options.actorIdentity, { email: "me@x.test" })
})

test("the user-info props name the notes folders only where they are worth naming", () => {
  const env = { agentConversationNotesFolder: "/c", agentSharedNotesFolder: "/s" }
  const project = buildUserInfoAgentNotesProps({ notesSessionId: "s" }, AgentMode.PROJECT, env)
  assert.equal(project.agentConversationNotesFolder, "/c")
  assert.equal(project.agentSharedNotesFolder, undefined)

  const agent = buildUserInfoAgentNotesProps({ notesSessionId: "s" }, AgentMode.AGENT, env)
  assert.equal(agent.agentConversationNotesFolder, "/c")
  assert.equal(agent.agentSharedNotesFolder, "/s")

  const withoutNotes = buildUserInfoAgentNotesProps({ notesSessionId: "s", enableAgentNotes: false }, AgentMode.AGENT, env)
  assert.equal(withoutNotes.agentConversationNotesFolder, undefined)
  assert.equal(withoutNotes.agentSharedNotesFolder, undefined)
})
