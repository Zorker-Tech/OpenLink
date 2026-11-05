import assert from "node:assert/strict"
import test from "node:test"

import { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { toRedactedSelectedContext } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import { CursorRuleSource } from "../../source/adapters/interop/proto/generated/agent/v1/rules_pb.ts"
import { fromInteropSelectedContextState, toInteropSelectedContextState } from "../../source/adapters/interop/agent/selected-context-state-adapter.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { RedactedBytes, RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { cloneSlateSelectedContextState } from "../../source/packages/agent/context/selected-context-state.ts"
import { projectSelectedContextForProcessing } from "../../source/adapters/interop/agent/selected-context-processing-adapter.ts"

test("every selected-context family survives the Slate schema boundary", () => {
  const source = new SelectedContext({
    selectedImages: [
      { uuid: "image-1", path: "/repo/image.png", mimeType: "image/png", dimension: { width: 8, height: 9 }, dataOrBlobId: { case: "blobIdWithData", value: { blobId: new Uint8Array([1]), data: new Uint8Array([2, 3]) } } },
      { uuid: "image-2", path: "/repo/upload.png", mimeType: "image/png", dataOrBlobId: { case: "promptUploadRef", value: { uploadId: "upload-2" } } },
    ],
    invocationContext: { data: { case: "ideState", value: {
      visibleFiles: [{ path: "/repo/open.ts", relativePath: "open.ts", cursorPosition: { line: 4, text: "return value" }, totalLines: 20, activeCommand: "test" }],
      recentlyViewedFiles: [{ path: "/repo/recent.ts", totalLines: 10 }],
      currentlyViewedPrs: [{ number: 5, url: "https://code.test/p/5", title: "Review", folderPath: "/review", summaryJson: "{}", description: "Details" }],
    } } },
    extraContext: ["note one", "note two"],
    files: [{ path: "/repo/a.ts", relativePath: "a.ts", content: "file content" }],
    codeSelections: [{ path: "/repo/b.ts", relativePath: "b.ts", content: "range content", range: { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } } }],
    terminals: [{ content: "terminal output", title: "build", path: "/repo" }],
    terminalSelections: [{ content: "selected output", title: "test", path: "/repo", range: { start: { line: 5, column: 1 } } }],
    folders: [{ path: "/repo/src", relativePath: "src", directoryTree: { absPath: "/repo/src", childrenWereProcessed: true, childrenFiles: [{ name: "index.ts", terminalMetadata: { cwd: "/repo", lastCommands: [{ command: "pnpm test", exitCode: 0, timestampMs: 12n, durationMs: 8n }] } }], childrenDirs: [], fullSubtreeExtensionCounts: { ts: 1 }, numFiles: 1 } }],
    externalLinks: [{ url: "https://docs.test/a", uuid: "link-1", pdfContent: "pdf text", isPdf: true, filename: "guide.pdf", blobId: new Uint8Array([4]) }],
    cursorRules: [{ rule: { fullPath: "/repo/.rules/style", content: "style", type: { type: { case: "fileGlobbed", value: { globs: ["*.ts"] } } }, source: CursorRuleSource.TEAM, gitRemoteOrigin: "git@example.test:repo", parseError: "", environments: ["local"], disabledEnvironments: ["ci"], plugin: "plugin", marketplace: "market", pluginId: "plugin-1", marketplaceId: "market-1", scopedTo: ["src"], frontmatter: "title: style", isRequired: true } }],
    gitDiffFromBranchToMain: { content: "branch diff", fullContentLengthCharCount: 11 },
    cursorCommands: [{ name: "check", content: "run checks", pluginCapability: { pluginId: "plugin-2", capabilityType: 77, sourcePath: "/plugin/check", snapshotToken: "snapshot", resolvedCommitSha: "abc" }, fullPath: "/plugin/check.md", displayName: "Check" }],
    documentations: [{ docId: "docs-1", name: "API guide" }],
    uiElements: [{ element: "button", xpath: "/html/button", textContent: "Save", extra: "extra details", component: "SaveButton", componentPropsJson: "{}" }],
    consoleLogs: [{ message: "failed", timestamp: 123.5, level: "error", clientName: "browser", sessionId: "session-1", stackTrace: { callFrames: [{ functionName: "save", url: "app.js", lineNumber: 4, columnNumber: 8 }], rawStackTrace: "stack" }, objectDataJson: "{\"code\":1}" }],
    extraContextEntries: [{ dataOrBlobId: { case: "data", value: "inline note" } }, { dataOrBlobId: { case: "blobId", value: new Uint8Array([5]) } }, { dataOrBlobId: { case: undefined } }],
    gitCommits: [{ sha: "commit-1", message: "subject", description: "details", diff: "patch" }],
    gitDiff: { content: "worktree diff", fullContentLengthCharCount: 13 },
    pastChats: [{ agentId: "conversation-1", name: "Earlier work" }],
    gitPrDiffSelections: [{ prUrl: "https://code.test/p/5", filePath: "src/a.ts", startLine: 4, endLine: 9, diffContent: "+line", blobId: new Uint8Array([6]) }],
    selectedPullRequests: [{ number: 5, url: "https://code.test/p/5", title: "Review", folderPath: "/review", summaryJson: "{}", description: "Details", blobId: new Uint8Array([7]) }],
    selectedSubagents: [{ name: "reviewer" }],
    selectedVideos: [{ uuid: "video-1", path: "/repo/video.mp4", filename: "video.mp4", mimeType: "video/mp4", fps: 24, materializeToFilesystem: true, dataOrBlobId: { case: "signedUrl", value: { url: "https://media.test/signed", key: "asset", expiresAtUnixMs: 200n, refreshAfterUnixMs: 100n, conversationId: "conversation-1" } } }],
    selectedBrowsers: [{ browserId: "browser-1", url: "https://app.test", pageTitle: "App" }],
    selectedDocuments: [{ uuid: "document-1", filename: "notes.txt", mimeType: "text/plain", path: "/repo/notes.txt", dataOrBlobId: { case: "data", value: new Uint8Array([8, 9]) } }],
    selectedSkills: [{ fullPath: "/repo/SKILL.md", content: "skill content", description: "skill description", parseError: "", environments: ["local"], disabledEnvironments: [], gitRemoteOrigin: "origin", disableModelInvocation: false, plugin: "plugin", marketplace: "market", pluginId: "plugin-3", marketplaceId: "market-3", globs: ["src/**"], scopedTo: ["src"] }],
    recentAgentsContext: { recentAgents: [{ name: "Builder", path: "/agents/builder", overview: "Builds" }] },
    selectedAgenticGitAction: { branchContext: { currentBranch: "feature", baseBranch: "main", agentBranchPrefix: "agent/" }, pathToTemplateFile: "/templates/pr.md", pathToTemplateDir: "/templates", params: { case: "commitAndPushParams", value: { filesToCommit: ["a.ts"], filesToExcludeFromCommit: ["b.ts"], shouldStageAllChanges: false, createPrDraft: true, filesToCommitWithStatus: [{ path: "a.ts", status: "modified" }], filesToExcludeFromCommitWithStatus: [{ path: "b.ts", status: "ignored" }] } } },
  } as never)

  const slate = fromInteropSelectedContextState(source)
  const restored = toInteropSelectedContextState(slate)

  assert.deepEqual(restored.toBinary(), source.toBinary())
  assert.equal(slate.schema, "slate.selected-context")
  assert.equal(slate.version, 1)
  assert.equal(slate.media.images[1]?.content?.kind, "upload")
  assert.equal(slate.workspace.folders[0]?.tree?.files[0]?.terminalMetadata?.lastCommands?.[0]?.timestampMs, 12n)
  assert.equal(slate.rules[0]?.rule?.source, "team")
  assert.equal(slate.commands[0]?.capability?.capability, "unknown-77")
  assert.equal(slate.repositoryAction?.parameters?.kind, "commit-and-push")
  assert.deepEqual(
    projectSelectedContextForProcessing(slate, { simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_COMMIT_AND_PUSH }),
    projectSelectedContextForProcessing(source, { simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_COMMIT_AND_PUSH }),
  )
})

test("all invocation variants and absent versus empty recent-agent selections round-trip", () => {
  const invocations = [
    { data: { case: "slackThread", value: { thread: "thread", channelName: "channel", channelPurpose: "purpose", channelTopic: "topic", senderName: "sender", senderId: "sender-1", senderType: "human", isDirectlyAddressed: true } } },
    { data: { case: "microsoftTeamsThread", value: { thread: "thread", channelName: "channel", teamName: "team", channelDescription: "channel info", teamDescription: "team info" } } },
    { data: { case: "githubPr", value: { title: "PR", description: "details", comments: "review", ciFailures: "tests" } } },
    { data: { case: "blobId", value: new Uint8Array([1, 2]) } },
    { data: { case: undefined } },
  ]
  for (const invocationContext of invocations) {
    const source = new SelectedContext({ invocationContext } as never)
    assert.deepEqual(toInteropSelectedContextState(fromInteropSelectedContextState(source)).toBinary(), source.toBinary())
  }
  const absent = new SelectedContext()
  const presentEmpty = new SelectedContext({ recentAgentsContext: { recentAgents: [] } } as never)
  assert.deepEqual(toInteropSelectedContextState(fromInteropSelectedContextState(absent)).toBinary(), absent.toBinary())
  assert.deepEqual(toInteropSelectedContextState(fromInteropSelectedContextState(presentEmpty)).toBinary(), presentEmpty.toBinary())
})

test("media payload cases and every repository-action variant survive the schema mapping", () => {
  const media = new SelectedContext({
    selectedImages: [
      { uuid: "image-data", path: "data.png", mimeType: "image/png", dataOrBlobId: { case: "data", value: new Uint8Array([1]) } },
      { uuid: "image-blob", path: "blob.png", mimeType: "image/png", dataOrBlobId: { case: "blobId", value: new Uint8Array([2]) } },
    ],
    selectedVideos: [
      { uuid: "video-data", path: "data.mp4", filename: "data.mp4", mimeType: "video/mp4", dataOrBlobId: { case: "data", value: new Uint8Array([3]) } },
      { uuid: "video-blob", path: "blob.mp4", filename: "blob.mp4", mimeType: "video/mp4", dataOrBlobId: { case: "blobId", value: new Uint8Array([4]) } },
      { uuid: "video-pair", path: "pair.mp4", filename: "pair.mp4", mimeType: "video/mp4", dataOrBlobId: { case: "blobIdWithData", value: { blobId: new Uint8Array([5]), data: new Uint8Array([6]) } } },
      { uuid: "video-empty", path: "empty.mp4", filename: "empty.mp4", mimeType: "video/mp4", dataOrBlobId: { case: undefined } },
    ],
    selectedDocuments: [
      { uuid: "doc-blob", filename: "blob.txt", path: "blob.txt", mimeType: "text/plain", dataOrBlobId: { case: "blobId", value: new Uint8Array([7]) } },
      { uuid: "doc-pair", filename: "pair.txt", path: "pair.txt", mimeType: "text/plain", dataOrBlobId: { case: "blobIdWithData", value: { blobId: new Uint8Array([8]), data: new Uint8Array([9]) } } },
      { uuid: "doc-upload", filename: "upload.txt", path: "upload.txt", mimeType: "text/plain", dataOrBlobId: { case: "promptUploadRef", value: { uploadId: "upload-10" } } },
    ],
  } as never)
  assert.deepEqual(toInteropSelectedContextState(fromInteropSelectedContextState(media)).toBinary(), media.toBinary())

  const commit = {
    filesToCommit: ["a.ts"],
    filesToExcludeFromCommit: ["b.ts"],
    shouldStageAllChanges: true,
    createPrDraft: false,
    filesToCommitWithStatus: [{ path: "a.ts", status: "modified" }],
    filesToExcludeFromCommitWithStatus: [{ path: "b.ts", status: "ignored" }],
  }
  const cases = [
    ["commitParams", commit],
    ["pushParams", { filesToPush: ["a.ts"], createPrDraft: true }],
    ["fixMergeConflictsParams", { baseBranch: "main", prUrl: "https://code.test/p/1" }],
    ["commitAndPushParams", commit],
    ["createPrParams", { createPrDraft: true }],
    ["createPrWithChangesParams", commit],
    ["babysitPrInCloudParams", { baseBranch: "main" }],
    ["createBranchAndCommitParams", commit],
    ["createBranchCommitAndPushParams", commit],
    ["applyLocallyParams", { remoteBranch: "feature" }],
    ["checkoutBranchParams", { remoteBranch: "feature" }],
    ["updateBranchParams", { baseBranch: "main" }],
    ["createBranchParams", {}],
  ] as const
  for (const [caseName, value] of cases) {
    const source = new SelectedContext({ selectedAgenticGitAction: { params: { case: caseName, value } } } as never)
    assert.deepEqual(toInteropSelectedContextState(fromInteropSelectedContextState(source)).toBinary(), source.toBinary(), caseName)
  }
})

test("redacted media and path values remain redacted while the Slate state is cloned", () => {
  const source = toRedactedSelectedContext(new SelectedContext({
    selectedImages: [{ uuid: "image-1", path: "/private/image.png", mimeType: "image/png", dataOrBlobId: { case: "data", value: new Uint8Array([10, 11]) } }],
  } as never), PrivacyMode.NO_STORAGE) as unknown as SelectedContext
  const slate = fromInteropSelectedContextState(source)
  const storedImage = slate.media.images[0]
  assert.ok(storedImage?.path instanceof RedactedString)
  if (storedImage?.content?.kind !== "inline") assert.fail("expected image bytes")
  assert.ok(storedImage.content.bytes instanceof RedactedBytes)
  assert.equal(storedImage.content.bytes.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).toString(), "10,11")

  const cloned = cloneSlateSelectedContextState(slate)
  const clonedImage = cloned.media.images[0]
  assert.ok(clonedImage?.path instanceof RedactedString)
  if (clonedImage?.content?.kind !== "inline") assert.fail("expected cloned image bytes")
  assert.ok(clonedImage.content.bytes instanceof RedactedBytes)
  assert.equal(clonedImage.content.bytes.__classification, DataClassification.CODE)
  assert.equal(clonedImage.content.bytes.__fieldName, "data")
})
