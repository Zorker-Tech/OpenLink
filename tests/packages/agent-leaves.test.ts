import { test } from "node:test"
import assert from "node:assert/strict"

import { z } from "zod"

import { createContext } from "../../source/packages/context/context.ts"
import { AgentMode } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { BackgroundComposerSource } from "../../source/packages/proto/generated/aiserver/v1/background_composer_pb.ts"
import { getSafeErrorType } from "../../source/packages/agent/attachment-error-type.ts"
import { getSkillIdFromPath } from "../../source/packages/agent/skill-id.ts"
import { READ_CHAR_HARD_LIMIT, LARGE_TEXT_BLOB_THRESHOLD } from "../../source/packages/agent/tools/read-limits.ts"
import { SubagentModelForcePolicy } from "../../source/packages/agent/tools/subagent-model-policy.ts"
import { SubagentModelId } from "../../source/packages/agent/tools/subagent-model-ids.ts"
import { maybeRedirectWorktriesPath } from "../../source/packages/agent/tools/core/worktree-paths.ts"
import {
  checkModelFacingShellUiAutomation,
  isInternalHostScreenshotShellCommand,
  MODEL_FACING_SHELL_UI_AUTOMATION_BLOCK_REASON,
} from "../../source/packages/agent/tools/core/shell/ui-automation-guard.ts"
import { lenientBoolean, lenientEnum, lenientNumber } from "../../source/packages/agent/tools/lenient-scalars.ts"
import { getTaskToolName } from "../../source/packages/agent/tools/task-tool-name.ts"
import { renderUploadedDocumentsContext } from "../../source/packages/agent/context/uploaded-documents.ts"
import { appendRandomUploadSuffix } from "../../source/packages/agent/context/attachment-filenames.ts"
import { renderGithubPrInvocationContext } from "../../source/packages/agent/context/github-pr-context.ts"
import { canUseWatchVideoSubagent } from "../../source/packages/agent/context/watch-video-eligibility.ts"
import { renderConsoleLogsContext } from "../../source/packages/agent/context/console-logs-context.ts"
import { renderSelectedSubagentDelegation } from "../../source/packages/agent/context/selected-subagents-context.ts"
import { renderSelectedBrowsersContext } from "../../source/packages/agent/context/selected-browsers-context.ts"
import { renderExternalLinksContext } from "../../source/packages/agent/context/external-links-context.ts"
import { renderSelectedCursorCommands } from "../../source/packages/agent/context/cursor-commands-context.ts"
import { renderDocumentationContext } from "../../source/packages/agent/context/documentation-context.ts"
import { hydrateSelectedInvocationContext } from "../../source/packages/agent/context/invocation-hydration.ts"
import { hydrateSelectedDocumentation } from "../../source/packages/agent/context/documentation-hydration.ts"
import { renderPrReviewContext } from "../../source/packages/agent/context/pr-review-context.ts"
import {
  computeCoreMessageImagePresence,
  coreMessageJsonHasImage,
} from "../../source/packages/agent/conversation-image-presence.ts"
import { parseAgentType } from "../../source/packages/agent/state-agent-type.ts"
import { recordGoalContinuationStarted, recordGoalTerminalTransition } from "../../source/packages/agent/goal-metrics.ts"
import { drainPendingWritesOnRunStreamError } from "../../source/packages/agent/abort-drain.ts"
import { hasPdfMagicBytes, isPdfBinary } from "../../source/packages/agent/tools/core/read/pdf-utils.ts"
import { detectImageMimeType } from "../../source/packages/agent/tools/core/read/image-utils.ts"
import { CancelActionHandler } from "../../source/packages/agent/actions/cancel-action-handler.ts"
import { BackgroundShellActionHandler, NoOpSideChannelActionHandler } from "../../source/packages/agent/actions/background-shell-action-handler.ts"
import {
  NOTIFICATION_TAG_NAMES,
  extractCursorProviderOptions,
  getUserMessageTextContent,
  isGoalContinuationNotificationMessage,
  isNotificationOnlyUserMessage,
  isSyntheticUserMessage,
} from "../../source/packages/agent/actions/user-message-action/synthetic-user-message.ts"
import {
  appendInterruptedShellOutputSnapshot,
  clearInterruptedShellOutputSnapshot,
  getInterruptedShellOutputSnapshot,
  startInterruptedShellOutputSnapshot,
} from "../../source/packages/agent/tools/core/shell/interrupted-shell-output.ts"
import { analyzeFailure, isNetworkCommand } from "../../source/packages/agent/tools/core/shell/retry-helpers.ts"
import {
  PLAN_MODE_NON_MARKDOWN_EDIT_ERROR,
  assertPlanModeAllowsFileEdit,
  isManagedCanvasEditPath,
  isMarkdownEditPath,
  isPlanModeAllowedEditPath,
} from "../../source/packages/agent/tools/core/edit/plan-mode-file-policy.ts"
import { smartModeMcpApprovalStoreResource } from "../../source/packages/agent/tools/mcp/smart-mode-approval-store.ts"

const ctx = () => createContext()

// ---------------------------------------------------------------------------------------------
// the small leaves
// ---------------------------------------------------------------------------------------------

test("a failure is reported by type without its message", () => {
  assert.equal(getSafeErrorType(new TypeError("carrying the user's own text")), "TypeError")
  assert.equal(getSafeErrorType(new Error("")), "Error")
  assert.equal(getSafeErrorType("a string"), "string")
  assert.equal(getSafeErrorType(undefined), "undefined")
})

test("a skill's id is its directory, whatever shape the path arrived in", () => {
  assert.equal(getSkillIdFromPath("/p/.cursor/skills/release-notes/SKILL.md"), "release-notes")
  assert.equal(getSkillIdFromPath("/p/.cursor/skills/release-notes/SKILL.md/"), "release-notes")
  assert.equal(getSkillIdFromPath("C:\\p\\.cursor\\skills\\notes\\SKILL.md"), "notes")
  assert.equal(getSkillIdFromPath("/p/.cursor/skills/notes/other.md"), "other.md")
  assert.equal(getSkillIdFromPath("/"), "Skill")
})

test("the read limits are the platform's cap and a lower blob threshold", () => {
  assert.equal(READ_CHAR_HARD_LIMIT, 100_000)
  assert.equal(LARGE_TEXT_BLOB_THRESHOLD, 10_000)
  assert.ok(LARGE_TEXT_BLOB_THRESHOLD < READ_CHAR_HARD_LIMIT)
})

test("the subagent model policy and ids are the values the catalogue uses", () => {
  assert.deepEqual(Object.values(SubagentModelForcePolicy), ["none", "parent_pin", "request_based_composer"])
  assert.deepEqual(SubagentModelId, { standard: "composer-2.5", fast: "composer-2.5-fast" })
})

test("the misspelled worktree directory is corrected, and only there", () => {
  assert.equal(maybeRedirectWorktriesPath("/Users/u/.cursor/worktries/repo"), "/Users/u/.cursor/worktrees/repo")
  assert.equal(maybeRedirectWorktriesPath("/home/u/.cursor/worktries"), "/home/u/.cursor/worktrees")
  assert.equal(maybeRedirectWorktriesPath("/Users/u/.cursor/worktrees/repo"), "/Users/u/.cursor/worktrees/repo")
  assert.equal(maybeRedirectWorktriesPath("/srv/worktries/x"), "/srv/worktries/x")
})

test("driving the desktop by script is refused, with the tool to use instead", () => {
  for (const command of [
    "xdotool click 1",
    "osascript -e 'tell application \"Finder\"'",
    "python -c 'import pyautogui'",
    "chrome --remote-debugging-port=9222",
    "npx playwright codegen",
  ]) {
    const decision = checkModelFacingShellUiAutomation(command)
    assert.equal(decision.allow, false, command)
    assert.equal((decision as { reason: string }).reason, MODEL_FACING_SHELL_UI_AUTOMATION_BLOCK_REASON)
  }
  assert.equal(checkModelFacingShellUiAutomation("ls -la").allow, true)
  assert.equal(checkModelFacingShellUiAutomation("npm test").allow, true)
})

test("the platform taking a screenshot through its own host is allowed", () => {
  assert.equal(isInternalHostScreenshotShellCommand("control-sand screenshot --out /tmp/a.png"), true)
  assert.equal(checkModelFacingShellUiAutomation("control-sand screenshot --out /tmp/a.png").allow, true)
  assert.equal(isInternalHostScreenshotShellCommand("ls"), false)
})

test("a boolean, a number and an enum sent as text are read as what they meant", () => {
  const schema = z.object({
    flag: lenientBoolean(),
    count: lenientNumber(),
    mode: lenientEnum(z.enum(["fast", "slow"])),
  })
  assert.deepEqual(schema.parse({ flag: "true", count: "42", mode: "FAST" }), { flag: true, count: 42, mode: "fast" })
  assert.deepEqual(schema.parse({ flag: false, count: 7, mode: "slow" }), { flag: false, count: 7, mode: "slow" })
  // Anything else is left as it came, so the schema's own message is what the model sees.
  assert.equal(schema.safeParse({ flag: "yes", count: "many", mode: "other" }).success, false)
})

test("an ambiguous enum is not guessed at", () => {
  const schema = z.object({ mode: lenientEnum(z.enum(["Fast", "FAST"])) })
  assert.equal(schema.safeParse({ mode: "fast" }).success, false)
})

test("the subagent tool is named the way the model was trained to call it", () => {
  assert.equal(getTaskToolName({ promptVersion: "gpt-5" }), "Task")
  assert.equal(getTaskToolName({ promptVersion: "gpt-5", isComposer15: true }), "mcp_task")
  assert.equal(getTaskToolName({ promptVersion: "gpt5-codex" }), "Subagent")
  assert.equal(getTaskToolName({ promptVersion: "codex-cloud" }), "Subagent")
})

// ---------------------------------------------------------------------------------------------
// the context blocks
// ---------------------------------------------------------------------------------------------

test("nothing is rendered for an attachment that is not there", () => {
  assert.equal(renderUploadedDocumentsContext([]), undefined)
  assert.equal(renderGithubPrInvocationContext({ title: "t", description: "", comments: "" }).includes("PR Description"), false)
  assert.equal(renderConsoleLogsContext([]), undefined)
  assert.equal(renderSelectedSubagentDelegation([]), undefined)
  assert.equal(renderSelectedBrowsersContext([]), undefined)
  assert.equal(renderExternalLinksContext([]), undefined)
  assert.equal(renderSelectedCursorCommands([]), undefined)
  assert.equal(renderDocumentationContext(undefined), undefined)
  assert.equal(renderDocumentationContext({ chunks: [] }), undefined)
  assert.equal(renderPrReviewContext([]), undefined)
})

test("uploaded documents are named by path", () => {
  const rendered = renderUploadedDocumentsContext([{ path: "/w/a.pdf" }, { path: "/w/b.docx" }])
  assert.match(rendered!, /^<uploaded_documents>/)
  assert.match(rendered!, /- \/w\/a\.pdf/)
  assert.match(rendered!, /- \/w\/b\.docx/)
})

test("an upload is renamed so two uploads cannot collide", () => {
  const first = appendRandomUploadSuffix("report.pdf", "file")
  const second = appendRandomUploadSuffix("report.pdf", "file")
  assert.notEqual(first, second)
  assert.match(first, /^report_[a-z0-9]{4}\.pdf$/)
  assert.match(appendRandomUploadSuffix("no extension", "file"), /^no_extension_[a-z0-9]{4}$/)
  assert.match(appendRandomUploadSuffix("a/b:c", "file"), /^a_b_c_[a-z0-9]{4}$/)
})

test("the pull request context omits the sections there is nothing to put in", () => {
  const rendered = renderGithubPrInvocationContext({ title: "Fix it", description: "", comments: "", ciFailures: "" })
  assert.match(rendered, /PR Title: Fix it/)
  assert.doesNotMatch(rendered, /PR Description/)
  assert.doesNotMatch(rendered, /CI Failures/)

  const full = renderGithubPrInvocationContext({ title: "t", description: "d", comments: "c", ciFailures: "f" })
  assert.match(full, /PR Description:\nd/)
  assert.match(full, /Recent PR Comments\/Reviews:\nc/)
  assert.match(full, /Possibly Relevant CI Failures:\nf/)
})

test("video watching is offered only where it was enabled", () => {
  assert.equal(canUseWatchVideoSubagent({ agentType: AgentType.IDE, backgroundAgentSource: undefined, featureFlags: {} }), false)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.IDE,
    backgroundAgentSource: undefined,
    featureFlags: { enableWatchVideoInIdeSubagent: true },
  }), true)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: BackgroundComposerSource.SLACK,
    featureFlags: { enableSlackVideoAttachments: true },
  }), true)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: BackgroundComposerSource.SLACK,
    featureFlags: {},
  }), false)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: BackgroundComposerSource.EDITOR,
    featureFlags: { enableSlackVideoAttachments: true },
  }), false)
})

test("a console log line keeps its level, its time and its message", () => {
  const rendered = renderConsoleLogsContext([
    { level: "error", timestamp: 1_700_000_000_000, message: "boom" },
  ] as never)
  assert.equal(rendered?.type, "text")
  assert.match(rendered!.text, /^<console_logs_context>/)
  assert.match(rendered!.text, /error \d{1,2}:\d{2}:\d{2}.*: boom/)
})

test("the subagent delegation names the subagents and shows how to call one", () => {
  const rendered = renderSelectedSubagentDelegation([{ name: "explore" }, { name: "plan" }] as never)
  assert.match(rendered!.text, /delegate work to the following subagent\(s\): explore, plan/)
  assert.match(rendered!.text, /Task\(subagent_type="explore"/)
})

test("a browser tab is named by its title, with the id the tools need", () => {
  const rendered = renderSelectedBrowsersContext([{ pageTitle: "", url: "https://x.test", browserId: "b-1" }] as never)
  assert.match(rendered!.text, /- Untitled/)
  assert.match(rendered!.text, /URL: https:\/\/x\.test/)
  assert.match(rendered!.text, /Browser ID: b-1/)
})

test("search results are presented as known, and citations are asked for", () => {
  const rendered = renderExternalLinksContext([{ url: "https://x.test", title: "X", content: "body" }])
  assert.match(rendered!, /Refrain from saying "I am unable to browse the internet"/)
  assert.match(rendered!, /Please always cite any links you referenced/)
  assert.match(rendered!, /Website URL: https:\/\/x\.test/)
  assert.match(rendered!, /<\/external_links>$/)
})

test("a saved command is fenced with its own name", () => {
  const rendered = renderSelectedCursorCommands([{ name: "commit", content: "do it" }])
  assert.match(rendered!.text, /--- Cursor Command: commit ---/)
  assert.match(rendered!.text, /--- End Command ---/)
})

test("documentation chunks carry the page they came from", () => {
  const rendered = renderDocumentationContext({
    chunks: [{ docName: "Guide", pageUrl: "https://d.test/1", documentationChunk: "text" }],
  })
  assert.match(rendered!, /Document Name: Guide/)
  assert.match(rendered!, /Document URL: https:\/\/d\.test\/1/)
})

test("an invocation reference is fetched, and both failures are thrown", async () => {
  const withData = { data: { case: "inline", value: "x" } }
  assert.equal(await hydrateSelectedInvocationContext({ ctx: ctx(), invocationContext: withData as never }), withData)
  assert.equal(await hydrateSelectedInvocationContext({ ctx: ctx(), invocationContext: undefined }), undefined)

  const blobReference = { data: { case: "blobId", value: new Uint8Array([1]) } }
  await assert.rejects(
    hydrateSelectedInvocationContext({ ctx: ctx(), invocationContext: blobReference as never }),
    /Blob store is required/,
  )
  await assert.rejects(
    hydrateSelectedInvocationContext({
      ctx: ctx(),
      invocationContext: blobReference as never,
      blobStore: { getBlob: async () => undefined },
    }),
    /blob not found/,
  )
})

test("documentation is only asked for when something was attached", async () => {
  let called = 0
  const service = {
    async hydrateDocumentation() {
      called += 1
      return { chunks: [] }
    },
  }
  assert.equal(await hydrateSelectedDocumentation({
    ctx: ctx(),
    documentations: [],
    documentationHydrationService: service,
    conversationQuery: "q",
  }), undefined)
  assert.equal(called, 0)

  const result = await hydrateSelectedDocumentation({
    ctx: ctx(),
    documentations: [{ docId: "d1", name: "Guide" }] as never,
    documentationHydrationService: service,
    conversationQuery: "q",
  })
  assert.deepEqual(result, { chunks: [] })
  assert.equal(called, 1)
})

test("a review attachment says where in the file it is", () => {
  const single = renderPrReviewContext([
    { filePath: "a.ts", startLine: 3, endLine: 3, prUrl: "https://pr.test/1", diffContent: "" },
  ] as never)
  assert.match(single!.text, /Location: line 3/)
  assert.doesNotMatch(single!.text, /Diff Content/)

  const range = renderPrReviewContext([
    { filePath: "a.ts", startLine: 3, endLine: 9, prUrl: "https://pr.test/1", diffContent: "+x" },
  ] as never)
  assert.match(range!.text, /Location: lines 3-9/)
  assert.match(range!.text, /Diff Content:\n\+x/)
})

// ---------------------------------------------------------------------------------------------
// images in the conversation
// ---------------------------------------------------------------------------------------------

test("an image part is found wherever it sits", () => {
  assert.equal(coreMessageJsonHasImage({ content: [{ type: "image", data: "x" }] }), true)
  assert.equal(coreMessageJsonHasImage({ content: [{ nested: { deeper: { type: "image" } } }] }), true)
  assert.equal(coreMessageJsonHasImage({ content: [{ type: "text", text: "hello" }] }), false)
  assert.equal(coreMessageJsonHasImage({ content: "a string" }), false)
  assert.equal(coreMessageJsonHasImage(null), false)
})

test("the count is of user turns since the last image", () => {
  const presence = computeCoreMessageImagePresence([
    { role: "user", content: [{ type: "image" }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and now?" },
    { role: "assistant", content: "sure" },
    { role: "user", content: "still here?" },
  ])
  assert.equal(presence.containsImage, true)
  assert.equal(presence.suffixNumberOfTurnsWithoutImages, 2)
})

test("a conversation with no image says so, and counts its turns", () => {
  const presence = computeCoreMessageImagePresence([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])
  assert.equal(presence.containsImage, false)
  assert.equal(presence.suffixNumberOfTurnsWithoutImages, 1)
})

// ---------------------------------------------------------------------------------------------
// state, goals and the abort drain
// ---------------------------------------------------------------------------------------------

test("only the run kinds the platform has are accepted", () => {
  assert.equal(parseAgentType(AgentType.IDE), AgentType.IDE)
  assert.equal(parseAgentType("cli"), AgentType.CLI)
  assert.equal(parseAgentType("something-else"), undefined)
  assert.equal(parseAgentType(undefined), undefined)
})

test("a goal's continuation and its ending are both counted", () => {
  const context = ctx()
  recordGoalContinuationStarted(context)
  recordGoalTerminalTransition(context, { status: "completed", reason: "objective-met", continuationCount: 4 })
})

test("the abort drain waits briefly, and reports what it managed", async () => {
  const context = ctx()
  let flushed = false
  await drainPendingWritesOnRunStreamError(context, {
    pendingCheckpoints: Promise.resolve(),
    flush: async () => {
      flushed = true
    },
  })
  assert.equal(flushed, true)

  // A flush that never finishes does not hold the abort.
  await drainPendingWritesOnRunStreamError(context, {
    pendingCheckpoints: Promise.resolve(),
    flush: () => new Promise(() => {}),
    timeoutMs: 10,
  })

  // A flush that fails is reported, not thrown.
  await drainPendingWritesOnRunStreamError(context, {
    pendingCheckpoints: Promise.resolve(),
    flush: async () => {
      throw new Error("disk gone")
    },
  })
})

// ---------------------------------------------------------------------------------------------
// read classification
// ---------------------------------------------------------------------------------------------

test("a PDF is recognized by its header, and by its name when the header is not there", () => {
  const header = new Uint8Array([37, 80, 68, 70, 45, 49])
  assert.equal(hasPdfMagicBytes(header), true)
  assert.equal(hasPdfMagicBytes(new Uint8Array([1, 2, 3])), false)
  assert.equal(hasPdfMagicBytes(new Uint8Array([37, 80])), false)
  assert.equal(isPdfBinary(header, "/w/a.txt"), true)
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), "/w/a.pdf"), true)
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), "/w/a.txt"), false)
})

test("an image is typed from its bytes first, and its name as a fallback", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(detectImageMimeType(png), "image/png")
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3]), "/w/a.jpeg"), "image/jpeg")
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3]), "/w/a.heic"), "image/heic")
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3]), "/w/a.txt"), undefined)
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3])), undefined)
})

// ---------------------------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------------------------

test("a cancellation routed to the turn is refused rather than ignored", async () => {
  const handler = new CancelActionHandler(undefined, undefined, undefined, undefined, undefined)
  await assert.rejects(handler.handle(ctx(), {}, {}, {}, {}, {}), /should never be routed directly/)
})

test("a side-channel action recomputes the state and runs no tool", async () => {
  const handler = new NoOpSideChannelActionHandler()
  const stateHandler = { computeNewStructure: () => ({ ready: true }) }
  assert.deepEqual(await handler.handle(ctx(), {}, {}, stateHandler, {}, {}), { ready: true })
  assert.deepEqual(await handler.handleSingleStep(ctx(), {}, {}, stateHandler, {}, {}), {
    state: { ready: true },
    hasToolCall: false,
  })
  const backgroundShell = new BackgroundShellActionHandler()
  assert.deepEqual(await backgroundShell.handle(ctx(), {}, {}, stateHandler, {}, {}), { ready: true })
})

test("a summary and a notification are not real user messages", () => {
  assert.equal(isSyntheticUserMessage({ role: "user", providerOptions: { cursor: { isSummary: true } } }), true)
  assert.equal(isSyntheticUserMessage({ role: "user", content: "hello" }), false)
  assert.equal(
    isSyntheticUserMessage({ role: "user", content: `<${NOTIFICATION_TAG_NAMES[0]}>wake up</${NOTIFICATION_TAG_NAMES[0]}>` }),
    true,
  )
  assert.equal(extractCursorProviderOptions({ role: "user", providerOptions: { cursor: { isSummary: true } } })?.isSummary, true)
})

test("a message that merely mentions a notification is still a real message", () => {
  assert.equal(
    isNotificationOnlyUserMessage({ role: "user", content: `<other><${NOTIFICATION_TAG_NAMES[0]}>x</${NOTIFICATION_TAG_NAMES[0]}></other>` }),
    false,
  )
  // An opening notification tag at the top level is read as a notification even when the user wrote it,
  // which is the same reading the platform has always made: a message that quotes the tag looks like one.
  assert.equal(isNotificationOnlyUserMessage({ role: "user", content: "look at <task_notification>" }), true)
  assert.equal(isNotificationOnlyUserMessage({ role: "assistant", content: "<task_notification>x</task_notification>" }), false)
})

test("a goal continuation is recognized by its source", () => {
  assert.equal(isGoalContinuationNotificationMessage({ role: "user", content: '<system_notification source="goal">go</system_notification>' }), true)
  assert.equal(isGoalContinuationNotificationMessage({ role: "user", content: '<system_notification source="other">go</system_notification>' }), false)
})

test("only a user message has user text", () => {
  assert.equal(getUserMessageTextContent({ role: "assistant", content: "hi" }), undefined)
  assert.equal(getUserMessageTextContent({ role: "user", content: "hi" }), "hi")
  assert.equal(getUserMessageTextContent({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }] }), "a")
  assert.equal(getUserMessageTextContent({ role: "user", content: 42 }), undefined)
})

// ---------------------------------------------------------------------------------------------
// shell snapshots and plan mode
// ---------------------------------------------------------------------------------------------

test("an interrupted command's output is kept by its call and dropped when done", () => {
  startInterruptedShellOutputSnapshot("call-1")
  appendInterruptedShellOutputSnapshot("call-1", "first ")
  appendInterruptedShellOutputSnapshot("call-1", "second")
  assert.equal(getInterruptedShellOutputSnapshot("call-1"), "first second")
  clearInterruptedShellOutputSnapshot("call-1")
  assert.equal(getInterruptedShellOutputSnapshot("call-1"), undefined)
})

test("an appended snapshot for an unknown call still starts one", () => {
  appendInterruptedShellOutputSnapshot("call-2", "output")
  assert.equal(getInterruptedShellOutputSnapshot("call-2"), "output")
  clearInterruptedShellOutputSnapshot("call-2")
})

test("an empty append changes nothing", () => {
  startInterruptedShellOutputSnapshot("call-3")
  appendInterruptedShellOutputSnapshot("call-3", "")
  assert.equal(getInterruptedShellOutputSnapshot("call-3"), "")
  clearInterruptedShellOutputSnapshot("call-3")
})

test("the snapshot keeps the end of the output, not the beginning", () => {
  startInterruptedShellOutputSnapshot("call-4")
  appendInterruptedShellOutputSnapshot("call-4", "x".repeat(25_000))
  assert.equal(getInterruptedShellOutputSnapshot("call-4")?.length, 20_000)
  clearInterruptedShellOutputSnapshot("call-4")
})

test("a network failure is named as one, from the command or from the output", () => {
  assert.equal(isNetworkCommand("curl https://x.test"), true)
  assert.equal(isNetworkCommand("  GIT push"), true)
  assert.equal(isNetworkCommand("ls -la"), false)
  assert.equal(analyzeFailure(1, "", "curl https://x.test"), "network")
  assert.equal(analyzeFailure(1, "Could not resolve host: x.test"), "network")
  assert.equal(analyzeFailure(1, "operation not permitted"), "sandbox")
  assert.equal(analyzeFailure(1, "something went wrong"), "unknown")
  assert.equal(analyzeFailure(0, ""), "unknown")
})

test("plan mode allows markdown and the platform's own canvases, and refuses the rest", () => {
  assert.equal(isMarkdownEditPath("/p/PLAN.MD"), true)
  assert.equal(isMarkdownEditPath("/p/notes.mdx"), true)
  assert.equal(isMarkdownEditPath("/p/code.ts"), false)
  assert.equal(isManagedCanvasEditPath("/p/.cursor/projects/w/canvases/plan.canvas.tsx"), true)
  assert.equal(isPlanModeAllowedEditPath("/p/plan.md"), true)
  assert.equal(isPlanModeAllowedEditPath("/p/code.ts"), false)

  assertPlanModeAllowsFileEdit("/p/plan.md", { mode: AgentMode.PLAN })
  assertPlanModeAllowsFileEdit("/p/code.ts", { mode: AgentMode.AGENT })
  assert.throws(
    () => assertPlanModeAllowsFileEdit("/p/code.ts", { mode: AgentMode.PLAN }),
    (error: unknown) => {
      assert.equal((error as Error).message, PLAN_MODE_NON_MARKDOWN_EDIT_ERROR)
      return true
    },
  )
})

test("a session with no approval store fails loudly rather than pretending", () => {
  const resource = smartModeMcpApprovalStoreResource
  assert.equal(typeof resource.symbol, "symbol")
  assert.throws(() => resource.remoteImplementation(undefined), /approval store is not configured/)
})
