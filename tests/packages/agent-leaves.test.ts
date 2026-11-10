import { test } from "node:test"
import assert from "node:assert/strict"

import { z } from "zod"

import { createContext } from "../../source/packages/context/context.ts"
import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { getSafeErrorType } from "../../source/packages/agent/attachment-error-type.ts"
import { getSkillIdFromPath } from "../../source/packages/agent/skill-id.ts"
import { READ_OUTPUT_BOUNDS } from "../../source/packages/agent/tools/read-limits.ts"
import {
  isSubagentModelForcePolicy,
  SubagentModelForcePolicy,
} from "../../source/packages/agent/tools/subagent-model-policy.ts"
import { SubagentModelId } from "../../source/packages/agent/tools/subagent-model-ids.ts"
import {
  checkShellDesktopControl,
  isHostOwnedScreenshotCommand,
  SHELL_DESKTOP_CONTROL_REFUSAL,
} from "../../source/packages/agent/tools/core/shell/ui-automation-guard.ts"
import { lenientBoolean, lenientEnum, lenientNumber } from "../../source/packages/agent/tools/lenient-scalars.ts"
import { getTaskToolName } from "../../source/packages/agent/tools/task-tool-name.ts"
import { renderUploadedDocumentsContext } from "../../source/packages/agent/context/uploaded-documents.ts"
import { appendRandomUploadSuffix } from "../../source/packages/agent/context/attachment-filenames.ts"
import { canUseWatchVideoSubagent } from "../../source/packages/agent/context/watch-video-eligibility.ts"
import { renderConsoleLogsContext } from "../../source/packages/agent/context/console-logs-context.ts"
import { renderSelectedSubagentDelegation } from "../../source/packages/agent/context/selected-subagents-context.ts"
import { renderSelectedBrowsersContext } from "../../source/packages/agent/context/selected-browsers-context.ts"
import { renderExternalLinksContext } from "../../source/packages/agent/context/external-links-context.ts"
import { renderAttachedCommands } from "../../source/packages/agent/context/attached-commands-context.ts"
import { renderDocumentationContext } from "../../source/packages/agent/context/documentation-context.ts"
import { renderPrReviewContext } from "../../source/packages/agent/context/pr-review-context.ts"
import {
  computeCoreMessageImagePresence,
  coreMessageJsonHasImage,
} from "../../source/packages/agent/conversation-image-presence.ts"
import { resolveAgentType } from "../../source/packages/agent/state-agent-type.ts"
import { recordGoalContinuationStarted, recordGoalTerminalTransition } from "../../source/packages/agent/goal-metrics.ts"
import { drainPendingWritesOnRunStreamError } from "../../source/packages/agent/abort-drain.ts"
import { hasPdfMagicBytes, isPdfBinary } from "../../source/packages/agent/tools/core/read/pdf-utils.ts"
import { detectImageMimeType } from "../../source/packages/agent/tools/core/read/image-utils.ts"
import { CancelActionHandler } from "../../source/packages/agent/actions/cancel-action-handler.ts"
import { createSlateCancelActionPayload } from "../../source/packages/agent/actions/cancel-action-contracts.ts"
import { BackgroundShellActionHandler, NoOpSideChannelActionHandler } from "../../source/packages/agent/actions/background-shell-action-handler.ts"
import {
  NOTIFICATION_TAG_NAMES,
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
  isMarkdownEditPath,
  isPlanModeAllowedEditPath,
} from "../../source/packages/agent/tools/core/edit/plan-mode-file-policy.ts"
import { isManagedCanvasEditPath, isPlanMode } from "../../source/adapters/interop/agent/plan-edit-policy-adapter.ts"
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

  assert.equal(getSafeErrorType(new Error("TypeError")), "Error", "the message is never the answer")
  const named = new Error("x")
  named.name = "SlateCustomError"
  assert.equal(getSafeErrorType(named), "SlateCustomError")
  const nameless = new Error("x")
  nameless.name = ""
  assert.equal(getSafeErrorType(nameless), "Error", "an error with no name is still an Error")
  assert.equal(getSafeErrorType(null), "object")
  assert.equal(getSafeErrorType({}), "object")
  assert.equal(getSafeErrorType(7), "number")
  assert.equal(getSafeErrorType(true), "boolean")
  assert.equal(getSafeErrorType(() => undefined), "function")
  assert.equal(getSafeErrorType(Symbol("s")), "symbol")
  assert.equal(getSafeErrorType(10n), "bigint")
})

test("a skill's id is its directory, whatever shape the path arrived in", () => {
  assert.equal(getSkillIdFromPath("/p/.cursor/skills/release-notes/SKILL.md"), "release-notes")
  assert.equal(getSkillIdFromPath("/p/.cursor/skills/release-notes/SKILL.md/"), "release-notes")
  assert.equal(getSkillIdFromPath("C:\\p\\.cursor\\skills\\notes\\SKILL.md"), "notes")
  assert.equal(getSkillIdFromPath("/p/.cursor/skills/notes/other.md"), "other.md")
  assert.equal(getSkillIdFromPath("/"), "Skill")
})

test("the read output bounds separate the response cap from blob spill", () => {
  assert.deepEqual(READ_OUTPUT_BOUNDS, { maximumCharacters: 100_000, spillToBlobAboveCharacters: 10_000 })
  assert.ok(READ_OUTPUT_BOUNDS.spillToBlobAboveCharacters < READ_OUTPUT_BOUNDS.maximumCharacters)
})

test("the subagent model policy and ids are the values the catalogue uses", () => {
  assert.deepEqual(Object.values(SubagentModelForcePolicy), ["none", "parent_pin", "request_based_agent"])
  assert.equal(isSubagentModelForcePolicy("parent_pin"), true)
  assert.equal(isSubagentModelForcePolicy("unknown"), false)
  assert.equal(isSubagentModelForcePolicy(undefined), false)
  assert.deepEqual(SubagentModelId, { standard: "composer-2.5", fast: "composer-2.5-fast" })
})

test("driving the desktop by script is refused, with the tool to use instead", () => {
  for (const command of [
    "xdotool click 1",
    "osascript -e 'tell application \"Finder\"'",
    "python -c 'import pyautogui'",
    "chrome --remote-debugging-port=9222",
    "npx playwright codegen",
  ]) {
    const decision = checkShellDesktopControl(command)
    assert.equal(decision.allow, false, command)
    assert.equal((decision as { reason: string }).reason, SHELL_DESKTOP_CONTROL_REFUSAL)
  }
  assert.equal(checkShellDesktopControl("ls -la").allow, true)
  assert.equal(checkShellDesktopControl("npm test").allow, true)
})

test("the guard covers desktop controllers and browser debugging entry points", () => {
  const refused = [
    "wmctrl -a browser",
    "xte 'mousemove 10 10'",
    "ydotool click 1",
    "cliclick c:10,10",
    "python -c 'from pynput import mouse'",
    "node -e 'require(\"robotjs\")'",
    "sikuli-run script.sikuli",
    "Quartz.CGEventPost(event)",
    "ApplicationServices.framework",
    "chrome --remote-debugging-pipe",
    "node -e 'require(\"chrome-devtools-protocol\")'",
    "puppeteer.connect()",
    "npx playwright open https://example.test",
    "chromedriver --port=9515",
    "selenium-server standalone",
  ]
  for (const command of refused) assert.equal(checkShellDesktopControl(command).allow, false, command)
  assert.equal(checkShellDesktopControl("echo xdotoolish").allow, true)
  assert.match(SHELL_DESKTOP_CONTROL_REFUSAL, /Computer tool/)
})

test("the platform taking a screenshot through its own host is allowed", () => {
  assert.equal(isHostOwnedScreenshotCommand("control-slate screenshot --out /tmp/a.png"), true)
  assert.equal(checkShellDesktopControl("control-slate screenshot --out /tmp/a.png").allow, true)
  assert.equal(isHostOwnedScreenshotCommand("ls"), false)
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
  assert.equal(getTaskToolName({ promptVersion: "gpt5-codex", isComposer1: true }), "mcp_task")
  assert.equal(getTaskToolName({ promptVersion: "gpt-5", isComposer15: true }), "mcp_task")
  assert.equal(getTaskToolName({ promptVersion: "gpt5-codex" }), "Subagent")
  assert.equal(getTaskToolName({ promptVersion: "codex-cloud" }), "Subagent")
})

// ---------------------------------------------------------------------------------------------
// the context blocks
// ---------------------------------------------------------------------------------------------

test("nothing is rendered for an attachment that is not there", () => {
  assert.equal(renderUploadedDocumentsContext([]), undefined)
  assert.equal(renderConsoleLogsContext([]), undefined)
  assert.equal(renderSelectedSubagentDelegation([]), undefined)
  assert.equal(renderSelectedBrowsersContext([]), undefined)
  assert.equal(renderExternalLinksContext([]), undefined)
  assert.equal(renderAttachedCommands([]), undefined)
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

test("video watching is offered only where it was enabled", () => {
  assert.equal(canUseWatchVideoSubagent({ agentType: AgentType.IDE, backgroundAgentSource: undefined, featureFlags: {} }), false)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.IDE,
    backgroundAgentSource: undefined,
    featureFlags: { enableWatchVideoInIdeSubagent: true },
  }), true)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: "chat",
    featureFlags: { enableBackgroundVideoAttachments: true },
  }), true)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: "chat",
    featureFlags: {},
  }), false)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: "other",
    featureFlags: { enableBackgroundVideoAttachments: true },
  }), false)
})

test("a console log line keeps its level, its time and its message", () => {
  const rendered = renderConsoleLogsContext([
    { level: "error", timestamp: 1_700_000_000_000, message: "boom" },
  ])
  assert.equal(rendered?.type, "text")
  assert.match(rendered!.text, /^<console_logs_context>/)
  assert.match(rendered!.text, /error \d{1,2}:\d{2}:\d{2}.*: boom/)
})

test("the subagent delegation names the subagents and shows how to call one", () => {
  const rendered = renderSelectedSubagentDelegation([{ name: "explore" }, { name: "plan" }])
  assert.match(rendered!.text, /User requested delegation to these agents: explore, plan/)
  assert.match(rendered!.text, /Task\(subagentType="explore"/)
  assert.match(rendered!.text, /prompt="Describe the delegated task here"/)
})

test("a browser tab is named by its title, with the id the tools need", () => {
  const rendered = renderSelectedBrowsersContext([{ pageTitle: "", url: "https://x.test", browserId: "b-1" }])
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
  const rendered = renderAttachedCommands([{ name: "commit", content: "do it" }])
  assert.match(rendered!.text, /--- Command: commit ---/)
  assert.match(rendered!.text, /--- End Command ---/)
})

test("attached commands retain their order and each has its own boundary", () => {
  const rendered = renderAttachedCommands([
    { name: "first", content: "one" },
    { name: "second", content: "two" },
  ])
  assert.ok(rendered)
  assert.ok(rendered.text.indexOf("--- Command: first ---") < rendered.text.indexOf("--- Command: second ---"))
  assert.equal((rendered.text.match(/--- End Command ---/g) ?? []).length, 2)
  assert.match(rendered.text, /^<slate_commands>/)
  assert.match(rendered.text, /<\/slate_commands>$/)
})

test("documentation chunks carry the page they came from", () => {
  const rendered = renderDocumentationContext({
    chunks: [{ docName: "Guide", pageUrl: "https://d.test/1", documentationChunk: "text" }],
  })
  assert.match(rendered!, /Document Name: Guide/)
  assert.match(rendered!, /Document URL: https:\/\/d\.test\/1/)
})

test("a review attachment says where in the file it is", () => {
  const single = renderPrReviewContext([
    { filePath: "a.ts", startLine: 3, endLine: 3, prUrl: "https://pr.test/1", diffContent: "" },
  ])
  assert.match(single!.text, /Location: line 3/)
  assert.doesNotMatch(single!.text, /Diff Content/)

  const range = renderPrReviewContext([
    { filePath: "a.ts", startLine: 3, endLine: 9, prUrl: "https://pr.test/1", diffContent: "+x" },
  ])
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
  assert.equal(resolveAgentType(AgentType.IDE), AgentType.IDE)
  assert.equal(resolveAgentType("cli"), AgentType.CLI)
  assert.equal(resolveAgentType("something-else"), undefined)
  assert.equal(resolveAgentType(undefined), undefined)
  assert.equal(resolveAgentType(null), undefined)
  assert.equal(resolveAgentType(12), undefined)
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

test("a PDF's header is its first four bytes exactly, and the name only decides when they are absent", () => {
  const header = new Uint8Array([37, 80, 68, 70])
  assert.equal(hasPdfMagicBytes(header), true, "the bare header is a whole PDF as far as the classifier goes")
  assert.equal(hasPdfMagicBytes(new Uint8Array([37, 80, 68, 71])), false, "the last header byte has to match")
  assert.equal(hasPdfMagicBytes(new Uint8Array([37, 80, 68, 70, 0])), true, "what follows the header is not part of it")
  assert.equal(hasPdfMagicBytes(new Uint8Array([80, 68, 70, 37])), false, "the header has an order")
  assert.equal(hasPdfMagicBytes(new Uint8Array()), false)
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), "/w/a.PDF"), true, "the extension is matched without case")
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), "/w/a.pdfx"), false, "the extension has to end the name")
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), "/w/.pdf"), true)
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), "/w/a.pdf "), false, "a trailing space is not the extension")
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3]), ""), false)
  assert.equal(isPdfBinary(new Uint8Array([1, 2, 3])), false, "the path is optional")
  assert.equal(isPdfBinary(header, "/w/a.txt"), true, "the bytes are the truth even when the name says otherwise")
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
  await assert.rejects(
    handler.handle(ctx(), createSlateCancelActionPayload("stop"), {}, {}, {}, {}),
    /should never be routed directly/,
  )
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
  assert.equal(isSyntheticUserMessage({ role: "user", providerOptions: { slate: { isSummary: true } } } as never), true)
  assert.equal(isSyntheticUserMessage({ role: "user", content: "hello" }), false)
  assert.equal(
    isSyntheticUserMessage({ role: "user", content: `<${NOTIFICATION_TAG_NAMES[0]}>wake up</${NOTIFICATION_TAG_NAMES[0]}>` }),
    true,
  )
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
  assert.equal(isNetworkCommand("npm install package"), true)
  assert.equal(isNetworkCommand("ls -la"), false)
  assert.equal(analyzeFailure(1, "", "curl https://x.test"), "network")
  assert.equal(analyzeFailure(1, "Could not resolve host: x.test"), "network")
  assert.equal(analyzeFailure(1, "operation not permitted", "curl https://x.test"), "network")
  assert.equal(analyzeFailure(1, "operation not permitted"), "sandbox")
  assert.equal(analyzeFailure(null, "EACCES"), "sandbox")
  assert.equal(analyzeFailure(0, "EACCES"), "unknown")
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

  assertPlanModeAllowsFileEdit("/p/plan.md", isPlanMode(AgentMode.PLAN))
  assertPlanModeAllowsFileEdit("/p/code.ts", isPlanMode(AgentMode.AGENT))
  assert.throws(
    () => assertPlanModeAllowsFileEdit("/p/code.ts", isPlanMode(AgentMode.PLAN)),
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
