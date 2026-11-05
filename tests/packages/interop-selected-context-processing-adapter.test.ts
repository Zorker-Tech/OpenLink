import assert from "node:assert/strict"
import { test } from "node:test"

import { SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import type { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { projectSelectedContextForProcessing } from "../../source/adapters/interop/agent/selected-context-processing-adapter.ts"

test("the full prompt-processing view maps every selected-context family to Slate values", () => {
  const selected = {
    selectedImages: [{ uuid: "image-1", path: "/repo/image.png", mimeType: "image/png", dataOrBlobId: { case: "data", value: new Uint8Array([1, 2]) } }],
    selectedVideos: [{ path: "/repo/clip.mp4", filename: "clip.mp4", mimeType: "video/mp4", fps: 24, materializeToFilesystem: true, dataOrBlobId: { case: "data", value: new Uint8Array([3]) } }],
    selectedDocuments: [{ uuid: "doc-1", filename: "notes.md", mimeType: "text/markdown", path: "/repo/notes.md", dataOrBlobId: { case: "data", value: new Uint8Array([4]) } }],
    invocationContext: { data: { case: "ideState", value: { visibleFiles: [{ path: "/repo/open.ts", totalLines: 12 }], recentlyViewedFiles: [], currentlyViewedPrs: [] } } },
    files: [{ path: "/repo/readme.md", content: "file body", relativePath: "readme.md" }],
    codeSelections: [{ path: "/repo/main.ts", content: "selected lines", range: { start: { line: 4, column: 2 }, end: { line: 8, column: 5 } } }],
    terminals: [{ content: "$ pnpm test", title: "tests", path: "/repo" }],
    terminalSelections: [{ content: "output", title: "tests", path: "/repo", range: { start: { line: 1 }, end: { line: 1 } } }],
    folders: [{ path: "/repo/src", relativePath: "src" }],
    externalLinks: [{ url: "https://docs.example/guide" }],
    documentations: [{ docId: "docs-1", name: "Work guide" }],
    selectedPullRequests: [{ number: 17, url: "https://code.example/pull/17", title: "Fix", folderPath: "/workspace/review-17", summaryJson: "{}", description: "Review this", blobId: new Uint8Array([5]) }],
    gitPrDiffSelections: [{ prUrl: "https://code.example/pull/17", filePath: "src/main.ts", startLine: 4, endLine: 8, diffContent: "+line", blobId: new Uint8Array([6]) }],
    extraContextEntries: [
      { dataOrBlobId: { case: "data", value: "attached note" } },
      { dataOrBlobId: { case: "blobId", value: new Uint8Array([7]) } },
      { dataOrBlobId: { case: undefined } },
    ],
    extraContext: ["extra note"],
    selectedSkills: [{ fullPath: "/repo/.agents/skills/review/SKILL.md", content: "review guidance" }],
    cursorRules: [{ rule: { fullPath: "/repo/.cursor/rules/style.md", content: "style guidance" } }],
    cursorCommands: [{ name: "verify", content: "pnpm test" }],
    gitDiff: { content: "worktree diff", fullContentLengthCharCount: 13 },
    gitDiffFromBranchToMain: { content: "branch diff", fullContentLengthCharCount: 11 },
    gitCommits: [{ sha: "abc123", message: "subject", description: "explanation", diff: "patch" }],
    recentAgentsContext: { recentAgents: [{ name: "Builder", path: "/agents/builder", overview: "Builds changes" }] },
    uiElements: [{ element: "button", xpath: "/html/body/button", textContent: "Save", component: "SaveButton", componentPropsJson: "{}" }],
    selectedBrowsers: [{ url: "https://app.example", browserId: "browser-1", pageTitle: "Workspace" }],
    selectedSubagents: [{ name: "reviewer" }],
    consoleLogs: [{ level: "error", timestamp: 123, message: "failed" }],
    selectedAgenticGitAction: { pathToTemplateFile: "/templates/push.md", params: { case: "pushParams", value: {} } },
  } as unknown as SelectedContext

  const projected = projectSelectedContextForProcessing(selected, {
    simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_PUSH,
  })

  assert.equal(projected.images[0]?.id, "image-1")
  assert.deepEqual(projected.images[0]?.content, { kind: "inline-bytes", bytes: new Uint8Array([1, 2]) })
  assert.deepEqual(projected.videos[0]?.content, { kind: "bytes", bytes: new Uint8Array([3]) })
  assert.equal(projected.documents[0]?.uuid, "doc-1")
  assert.deepEqual(projected.invocation, {
    kind: "inline",
    context: {
      kind: "editor",
      editor: { visibleFiles: [{ path: "/repo/open.ts", totalLines: 12, activeCommand: undefined }], recentlyViewedFiles: [], openPullRequests: [] },
    },
  })
  assert.deepEqual(projected.workspace.files, [{ path: "/repo/readme.md", content: "file body", relativePath: "readme.md" }])
  assert.deepEqual(projected.workspace.codeSelections, [{ path: "/repo/main.ts", content: "selected lines", range: { start: { line: 4, column: 2 }, end: { line: 8, column: 5 } } }])
  assert.deepEqual(projected.externalLinkUrls, ["https://docs.example/guide"])
  assert.deepEqual(projected.documentReferences, [{ id: "docs-1", displayName: "Work guide" }])
  assert.deepEqual(projected.pullRequests, [{ number: 17, url: "https://code.example/pull/17", localReviewDirectory: "/workspace/review-17", title: "Fix", summaryDocument: "{}", description: "Review this", blobId: new Uint8Array([5]) }])
  assert.deepEqual(projected.pullRequestDiffs, [{ url: "https://code.example/pull/17", filePath: "src/main.ts", startLine: 4, endLine: 8, diff: "+line", blobId: new Uint8Array([6]) }])
  assert.deepEqual(projected.extraContextEntries, [
    { kind: "inline-text", text: "attached note" },
    { kind: "stored-text", blobId: new Uint8Array([7]) },
    { kind: "empty" },
  ])
  assert.deepEqual(projected.extraContextText, ["extra note"])
  assert.equal(projected.skillAttachments.explicitSkills?.[0]?.path, "/repo/.agents/skills/review/SKILL.md")
  assert.equal(projected.skillAttachments.ruleCandidates?.[0]?.text, "style guidance")
  assert.deepEqual(projected.nonMedia.attachedCommands, [{ name: "verify", content: "pnpm test" }])
  assert.deepEqual(projected.nonMedia.gitDiff, { content: "worktree diff", fullContentLengthCharCount: 13 })
  assert.deepEqual(projected.nonMedia.gitCommits, [{ objectId: "abc123", subject: "subject", explanation: "explanation", patch: "patch" }])
  assert.deepEqual(projected.recentAgents, [{ name: "Builder", path: "/agents/builder", overview: "Builds changes" }])
  assert.deepEqual(projected.uiElements, [{ element: "button", xpath: "/html/body/button", textContent: "Save", component: "SaveButton", componentPropsJson: "{}" }])
  assert.deepEqual(projected.browserTabs, [{ url: "https://app.example", browserId: "browser-1", pageTitle: "Workspace" }])
  assert.deepEqual(projected.selectedSubagents, [{ name: "reviewer" }])
  assert.deepEqual(projected.consoleLogs, [{ level: "error", timestamp: 123, message: "failed" }])
  assert.ok(projected.simulatedMessagePrompts.length > 0)
})

test("an omitted selected context becomes a complete empty Slate processing record", () => {
  assert.deepEqual(projectSelectedContextForProcessing(undefined), {
    images: [],
    videos: [],
    documents: [],
    workspace: { files: [], codeSelections: [], terminals: [], terminalSelections: [], folders: [] },
    externalLinkUrls: [],
    documentReferences: [],
    pullRequests: [],
    pullRequestDiffs: [],
    extraContextEntries: [],
    extraContextText: [],
    skillAttachments: { explicitSkills: [], ruleCandidates: [] },
    nonMedia: { attachedCommands: [], gitDiff: undefined, gitDiffFromBranchToMain: undefined, gitCommits: [] },
    recentAgents: [],
    uiElements: [],
    browserTabs: [],
    selectedSubagents: [],
    consoleLogs: [],
    simulatedMessagePrompts: [],
  })
})
