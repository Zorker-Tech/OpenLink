import { test } from "node:test"
import assert from "node:assert/strict"

import { processSelectedContext } from "../../source/packages/agent/context/process-selected-context.ts"
import { projectSelectedContextForProcessing } from "../../source/adapters/interop/agent/selected-context-processing-adapter.ts"
import { fromInteropAgentMode } from "../../source/adapters/interop/agent/mode-processing-adapter.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import type { WriteExecutorArgs, WriteExecutorResult } from "../../source/packages/agent-exec/write-operation.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { BackgroundComposerSource } from "../../source/adapters/interop/proto/generated/aiserver/v1/background_composer_pb.ts"
import {
  InvocationContext,
  InvocationContext_IdeState,
  InvocationContext_IdeState_File,
  SelectedAgenticGitAction,
  SelectedAgenticGitActionPushParams,
  SelectedCodeSelection,
  SelectedContext,
  SelectedDocument,
  SelectedImage,
  SelectedVideo,
} from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { agentEventTrackerKey, type AgentEventTracker } from "../../source/packages/agent/utils/event-tracking.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"

// ---------------------------------------------------------------------------------------------
// the services and stores a turn's attachments are moved through
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly writes: Array<{ path: string; text?: string; bytes?: Uint8Array }>
  readonly config: Record<string, unknown>
  readonly appliedSkills: Array<{ skillId: string; entrypoint: string; skillSource: string }>
  readonly ctx: Context
  readonly resourceAccessor: { get(): { execute(ctx: Context, args: WriteExecutorArgs): Promise<unknown> } }
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function harness(options: {
  page?: { pageUrl: string; pageTitle: string; partialParsedPageContents: string; imageData?: Uint8Array; imageMimeType?: string } | null
  projectFolder?: string
  featureFlags?: Record<string, unknown>
  writeFails?: boolean
  writeThrows?: boolean
} = {}): Harness {
  const writes: Harness["writes"] = []
  const appliedSkills: Harness["appliedSkills"] = []
  const tracker = {
    trackSkillApplied: (_ctx: Context, event: { skillId: string; entrypoint: string; skillSource: string }) => {
      appliedSkills.push({ skillId: event.skillId, entrypoint: event.entrypoint, skillSource: event.skillSource })
    },
  } as unknown as AgentEventTracker
  const ctx = createContext().with(agentEventTrackerKey, tracker)
  const writeExecutor = {
    async execute(_ctx: Context, args: WriteExecutorArgs): Promise<WriteExecutorResult> {
      if (options.writeThrows === true) throw new Error("the workspace is read-only")
      if (options.writeFails === true) return { kind: "error", path: args.path, error: "the workspace is read-only" }
      writes.push({ path: args.path, ...(args.text === undefined ? {} : { text: args.text }), ...(args.bytes === undefined ? {} : { bytes: args.bytes }) })
      return { kind: "success", path: args.path, linesWritten: args.text?.split("\n").length ?? 0, bytesWritten: args.bytes?.length ?? 0 }
    },
  }
  return {
    writes,
    appliedSkills,
    ctx,
    resourceAccessor: { get: () => writeExecutor as never },
    config: {
      enableTerminalFiles: false,
      enableAgentNotes: false,
      enableImageFiles: true,
      enableLongCodeSelectionSpillToFile: true,
      formattingOptions: {},
      conversationId: "conversation-1",
      featureFlags: options.featureFlags ?? {},
      webScraperService: {
        async getContentInWebsiteFast() { return options.page ?? null },
      },
      documentationHydrationService: {
        async hydrateDocumentation() { return { documentation: [] } },
      },
    },
  }
}

function blobStoreHarness(): { store: Record<string, unknown>; blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (id: Uint8Array): string => Buffer.from(id).toString("hex")
  return {
    blobs,
    store: {
      async getBlob(_ctx: Context, blobId: Uint8Array) { return blobs.get(keyOf(blobId)) },
      async setBlob(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
      async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
      async flush() {},
    },
  }
}

async function process(
  harnessed: Harness,
  selectedContext: SelectedContext,
  options: {
    projectFolder?: string
    requestContext?: Record<string, unknown>
    simulatedMsgReason?: number
    mode?: number
    privacyMode?: PrivacyMode
    modelId?: string
  } = {},
): Promise<Awaited<ReturnType<typeof processSelectedContext>>> {
  const projectFolder = options.projectFolder ?? "/repo"
  const requestContext = options.requestContext ?? { env: { projectFolder, workspacePaths: [projectFolder] } }
  const selectedContextForProcessing = projectSelectedContextForProcessing(selectedContext, {
    simulatedMsgReason: (options.simulatedMsgReason ?? SimulatedMsgReason.UNSPECIFIED) as never,
    modelInfo: harnessed.config.modelInfo as never,
    environmentParamForSubagent: (harnessed.config.featureFlags as Record<string, unknown> | undefined)?.environmentParamForSubagent === true,
    babysitV2Prompt: (harnessed.config.featureFlags as Record<string, unknown> | undefined)?.babysitV2Prompt === true,
    enablePrCreationForgeGuidance: (harnessed.config.featureFlags as Record<string, unknown> | undefined)?.prCreationForgeGuidance === true,
  })
  return await processSelectedContext(
    harnessed.ctx,
    selectedContextForProcessing,
    blobStoreHarness().store as never,
    harnessed.config as never,
    requestContext as never,
    harnessed.resourceAccessor as never,
    fromInteropAgentMode((options.mode ?? AgentMode.AGENT) as AgentMode) ?? SlateMode.AGENT,
    options.modelId ?? "composer-2",
    "what does this do?",
    options.privacyMode ?? PrivacyMode.NO_STORAGE,
  )
}

const textOf = (result: { userContent: Array<{ type: string; text?: string }> }): string =>
  result.userContent.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")

// ---------------------------------------------------------------------------------------------
// nothing attached
// ---------------------------------------------------------------------------------------------

test("a turn with nothing attached produces nothing", async () => {
  const result = await process(harness(), new SelectedContext({}))
  assert.deepEqual(result.userContent, [])
  assert.deepEqual(result.selectedImages, [])
  assert.deepEqual(result.selectedVideos, [])
  assert.deepEqual(result.selectedDocuments, [])
  assert.deepEqual(result.imageFilePaths, [])
})

test("the invocation a turn came from is written out first", async () => {
  const result = await process(harness(), new SelectedContext({
    invocationContext: new InvocationContext({
      data: {
        case: "ideState",
        value: new InvocationContext_IdeState({ visibleFiles: [new InvocationContext_IdeState_File({ path: "/repo/a.ts" })] }),
      },
    }),
  }))
  assert.equal(result.userContent.length, 1)
  assert.match(textOf(result), /<workspace_editor_context>/)
  assert.match(textOf(result), /- \/repo\/a\.ts/)
})

// ---------------------------------------------------------------------------------------------
// images, videos and documents
// ---------------------------------------------------------------------------------------------

test("an image already inside the workspace is used where it is", async () => {
  const harnessed = harness()
  const result = await process(harnessed, new SelectedContext({
    selectedImages: [new SelectedImage({ path: "/repo/diagram.png", mimeType: "image/png", dataOrBlobId: { case: "data", value: pngBytes } })],
  }))
  assert.equal(result.userContent.some(part => part.type === "image"), true)
  assert.equal(result.selectedImages.length, 1)
  assert.deepEqual(result.imageFilePaths, ["/repo/diagram.png"])
  assert.deepEqual(harnessed.writes, [])
})

test("an image from outside the workspace is copied into the project's assets", async () => {
  const harnessed = harness()
  const result = await process(harnessed, new SelectedContext({
    selectedImages: [new SelectedImage({ path: "/tmp/diagram.png", mimeType: "image/png", dataOrBlobId: { case: "data", value: pngBytes } })],
  }))
  assert.equal(result.imageFilePaths.length, 1)
  assert.match(result.imageFilePaths[0] ?? "", /^\/repo\/assets\//)
  assert.equal(harnessed.writes.length, 1)
})

test("an attached video written to disk is referred to by path, and the model is told it can watch it", async () => {
  const result = await process(harness(), new SelectedContext({
    selectedVideos: [new SelectedVideo({
      path: "/repo/clip.mp4",
      mimeType: "video/mp4",
      materializeToFilesystem: true,
      dataOrBlobId: { case: "data", value: new Uint8Array([1, 2, 3]) },
    })],
  }), { projectFolder: "/repo" })

  assert.equal(result.videoFilePaths.length, 1)
  assert.match(textOf(result), /<attached_videos>/)
  assert.match(textOf(result), /The following videos have been attached by the user and saved to your filesystem\./)
  assert.match(textOf(result), /- \/repo\/uploads\/clip_\w+\.mp4/)
  // No subagent is offered for this session, so the sentence about watching them is not added.
  assert.doesNotMatch(textOf(result), /WatchVideo subagent/)
})

test("background chat and automation video sources reach the Slate eligibility policy through interop", async () => {
  for (const backgroundAgentSource of [BackgroundComposerSource.SLACK, BackgroundComposerSource.AUTOMATIONS]) {
    const harnessed = harness({ featureFlags: { enableBackgroundVideoAttachments: true } })
    harnessed.config.agentType = AgentType.BACKGROUND
    harnessed.config.backgroundAgentSource = backgroundAgentSource
    const result = await process(harnessed, new SelectedContext({
      selectedVideos: [new SelectedVideo({
        path: "/repo/clip.mp4",
        mimeType: "video/mp4",
        materializeToFilesystem: true,
        dataOrBlobId: { case: "data", value: new Uint8Array([1, 2, 3]) },
      })],
    }), { projectFolder: "/repo" })

    assert.match(textOf(result), /You can watch them using your WatchVideo subagent/)
  }
})

test("an attached document is written out and listed", async () => {
  const result = await process(harness(), new SelectedContext({
    selectedDocuments: [new SelectedDocument({
      path: "",
      filename: "report.pdf",
      mimeType: "application/pdf",
      dataOrBlobId: { case: "data", value: new TextEncoder().encode("the report") },
    })],
  }))
  assert.equal(result.documentFilePaths.length, 1)
  assert.match(textOf(result), /<uploaded_documents>/)
  assert.match(textOf(result), /report_\w+\.pdf/)
})

// ---------------------------------------------------------------------------------------------
// code selections, terminals and folders
// ---------------------------------------------------------------------------------------------

test("a code selection is written into the attached files block", async () => {
  const result = await process(harness(), new SelectedContext({
    codeSelections: [new SelectedCodeSelection({
      path: "/repo/a.ts",
      content: "const a = 1",
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } } as never,
    })],
  }))
  assert.match(textOf(result), /^<attached_files>/)
  assert.match(textOf(result), /const a = 1/)
})

test("a long code selection is spilled to a file instead of inlined", async () => {
  const harnessed = harness()
  const longContent = "x".repeat(25_000)
  const result = await process(harnessed, new SelectedContext({
    codeSelections: [new SelectedCodeSelection({
      path: "/repo/big.ts",
      content: longContent,
      range: { start: { line: 1, character: 0 }, end: { line: 900, character: 0 } } as never,
    })],
  }))
  // The content goes to the workspace and the document is listed rather than pasted.
  assert.equal(harnessed.writes.some(write => write.path.includes("big")), true)
  assert.match(textOf(result), /<uploaded_documents>/)
  assert.doesNotMatch(textOf(result), /x{25_000}/)
})

test("a spilled code selection whose write throws is still shown inline", async () => {
  const harnessed = harness({ writeThrows: true })
  const longContent = "y".repeat(25_000)
  const result = await process(harnessed, new SelectedContext({
    codeSelections: [new SelectedCodeSelection({
      path: "/repo/big.ts",
      content: longContent,
      range: { start: { line: 1, character: 0 }, end: { line: 900, character: 0 } } as never,
    })],
  }))
  assert.match(textOf(result), /<attached_files>/)
  assert.match(textOf(result), /y{1000}/)
})

test("an attached folder is written into the attached files block", async () => {
  const result = await process(harness(), new SelectedContext({
    folders: [{
      path: "/repo/src",
      directoryTree: { absPath: "/repo/src", childrenDirs: [], childrenFiles: [], childrenWereProcessed: true, numFiles: 0 } as never,
    }],
  }))
  assert.match(textOf(result), /<attached_files>/)
  assert.match(textOf(result), /Folder: \/repo\/src/)
  assert.match(textOf(result), /Contents of directory:/)
})

test("a folder attached without its contents contributes nothing", async () => {
  const result = await process(harness(), new SelectedContext({ folders: [{ path: "/repo/src" } as never] }))
  assert.deepEqual(result.userContent, [])
})

// ---------------------------------------------------------------------------------------------
// links that have to be fetched
// ---------------------------------------------------------------------------------------------

test("a short page is inlined as an external link", async () => {
  const harnessed = harness({ page: { pageUrl: "https://example.test/a", pageTitle: "A page", partialParsedPageContents: "the page body" } })
  const result = await process(harnessed, new SelectedContext({
    externalLinks: [{ url: "https://example.test/a" } as never],
  }))
  assert.match(textOf(result), /the page body/)
  assert.equal(harnessed.writes.length, 0)
})

test("a long page is written to the workspace and listed instead of inlined", async () => {
  const harnessed = harness({
    page: { pageUrl: "https://example.test/long", pageTitle: "A long page", partialParsedPageContents: "z".repeat(30_000) },
  })
  const result = await process(harnessed, new SelectedContext({
    externalLinks: [{ url: "https://example.test/long" } as never],
  }))
  assert.equal(harnessed.writes.length, 1)
  assert.match(harnessed.writes[0]?.path ?? "", /\/repo\/uploads\/long-0\.md/)
  // The written file names its own source, so a reader knows where it came from.
  const written = new TextDecoder().decode(harnessed.writes[0]?.bytes ?? new Uint8Array())
  assert.match(written, /Source URL: https:\/\/example\.test\/long/)
  assert.match(textOf(result), /<uploaded_documents>/)
})

test("a page that is an image is shown as an image", async () => {
  const harnessed = harness({
    page: { pageUrl: "https://example.test/p.png", pageTitle: "A picture", partialParsedPageContents: "", imageData: pngBytes, imageMimeType: "image/png" },
  })
  const result = await process(harnessed, new SelectedContext({
    externalLinks: [{ url: "https://example.test/p.png" } as never],
  }))
  assert.equal(result.userContent.some(part => part.type === "image"), true)
})

test("a link that cannot be fetched contributes nothing", async () => {
  const harnessed = harness({ page: null })
  const result = await process(harnessed, new SelectedContext({
    externalLinks: [{ url: "https://example.test/gone" } as never],
  }))
  assert.deepEqual(result.userContent, [])
})

// ---------------------------------------------------------------------------------------------
// rules and skills the user attached
// ---------------------------------------------------------------------------------------------

test("attached rules are written as context the model may use", async () => {
  const result = await process(harness(), new SelectedContext({
    cursorRules: [{ rule: { fullPath: "/repo/.cursor/rules/style.md", content: "Always use semicolons." } } as never],
  }))
  assert.match(textOf(result), /<workspace_rules_context>/)
  assert.match(textOf(result), /Rule Name: style/)
  assert.match(textOf(result), /Always use semicolons\./)
})

test("a session that drops custom prompt context writes neither rules nor skills", async () => {
  const harnessed = harness({ featureFlags: { dropCustomPromptContext: true } })
  const result = await process(harnessed, new SelectedContext({
    cursorRules: [{ rule: { fullPath: "/repo/.cursor/rules/style.md", content: "Always use semicolons." } } as never],
    selectedSkills: [{ fullPath: "/repo/.cursor/skills/release/SKILL.md", content: "the skill body" } as never],
  }))
  assert.doesNotMatch(textOf(result), /workspace_rules_context/)
  assert.doesNotMatch(textOf(result), /manually_attached_skills/)
  assert.deepEqual(harnessed.appliedSkills, [])
})

test("a skill attached by hand is written out and recorded as used", async () => {
  const harnessed = harness()
  const result = await process(harnessed, new SelectedContext({
    selectedSkills: [{ fullPath: "/repo/.cursor/skills/release/SKILL.md", content: "the skill body" } as never],
  }))
  assert.match(textOf(result), /<manually_attached_skills>/)
  assert.match(textOf(result), /the skill body/)
  assert.deepEqual(harnessed.appliedSkills, [
    { skillId: "release", entrypoint: "manually_attached", skillSource: "workspace" },
  ])
})

// ---------------------------------------------------------------------------------------------
// the wake-up instruction, and what the session's flags change
// ---------------------------------------------------------------------------------------------

test("the instruction for a wake-up is written after everything attached", async () => {
  const result = await process(harness(), new SelectedContext({
    codeSelections: [new SelectedCodeSelection({
      path: "/repo/a.ts",
      content: "const a = 1",
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } } as never,
    })],
    selectedAgenticGitAction: new SelectedAgenticGitAction({
      params: { case: "createPrParams", value: new SelectedAgenticGitActionPushParams({}) },
    }),
  }), { simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR })

  const texts = result.userContent.filter(part => part.type === "text").map(part => part.text ?? "")
  assert.equal(texts.at(-1)?.startsWith("Push this branch to remote and create a pull request."), true)
})

test("the video size a session allows comes from its flags", async () => {
  const harnessed = harness({ featureFlags: { videoAttachmentInlineMaxBytes: 2 } })
  await assert.rejects(
    () => process(harnessed, new SelectedContext({
      selectedVideos: [new SelectedVideo({
        path: "/repo/clip.mp4",
        mimeType: "video/mp4",
        dataOrBlobId: { case: "data", value: new Uint8Array([1, 2, 3]) },
      })],
    }), { privacyMode: PrivacyMode.NO_STORAGE, modelId: "gemini-2.5-pro" }),
    /Video exceeds maximum size of 2 bytes/,
  )
})

test("agent notes are only written for a session that wants them", async () => {
  const withoutNotes = await process(harness(), new SelectedContext({}), {
    requestContext: { env: { projectFolder: "/repo", workspacePaths: ["/repo"] }, conversationNotesListing: "note one" },
  })
  assert.doesNotMatch(textOf(withoutNotes), /agent_notes/)

  const harnessed = harness()
  ;(harnessed.config as { enableAgentNotes: boolean }).enableAgentNotes = true
  const withNotes = await process(harnessed, new SelectedContext({}), {
    requestContext: { env: { projectFolder: "/repo", workspacePaths: ["/repo"] }, conversationNotesListing: "note one" },
  })
  assert.match(textOf(withNotes), /<agent_notes>/)
  assert.match(textOf(withNotes), /note one/)
})
