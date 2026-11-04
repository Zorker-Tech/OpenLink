import { test } from "node:test"
import assert from "node:assert/strict"

import {
  compact,
  compactHeadAndTail,
  describeSlateMcpAutoReviewAction,
  describeSlateShellAutoReviewAction,
  fallbackSlateMcpAutoReviewSummary,
  humanizeMcpToolAction,
  mentionsServer,
  redactMcpValue,
  safeMcpDestinationHint,
  summarizeSlateAutomationWriteAction,
  summarizeSlateBrowserAutoReviewAction,
  summarizeSlateCloudAgentAction,
  summarizeSlateCloudAgentLifecycleAction,
  summarizeSlateMcpAutoReviewAction,
  summarizeSlateSubagentAction,
  summarizeSlateComputerTypedText,
  summarizeTypedText,
} from "../../source/host/runner/slate-auto-review-summaries.ts"

test("a long text is compacted to the budget it is given, and never longer", () => {
  assert.equal(compact("  a   b  ", 20), "a b")
  assert.equal(compact("x".repeat(50), 10), "x".repeat(9) + "…")
  assert.equal(compact("x".repeat(10), 10), "x".repeat(10))
  const tail = compactHeadAndTail("x".repeat(500), 60)
  const parts = tail.match(/^(x+)…\[(\d+) chars skipped\]…(x+)$/)
  assert.notEqual(parts, null)
  assert.equal(Number(parts?.[2]), 500 - (parts?.[1]?.length ?? 0) - (parts?.[3]?.length ?? 0))
  assert.equal(tail.length <= 60, true)
  assert.equal(compactHeadAndTail("a", 5), "a")
  for (const budget of [48, 60, 61, 80]) {
    const clipped = compactHeadAndTail("start " + "m".repeat(300) + " finish", budget)
    assert.equal(clipped.length <= budget, true)
    assert.equal(clipped.startsWith("start"), true)
    assert.equal(clipped.endsWith("finish"), true)
  }
  const oddSplit = compactHeadAndTail("x".repeat(500), 62).match(/^(x+)…\[(\d+) chars skipped\]…(x+)$/)
  assert.notEqual(oddSplit, null)
  assert.equal(oddSplit?.[1]?.length, (oddSplit?.[3]?.length ?? 0) + 1)
})

test("secrets are redacted before a value is shown", () => {
  assert.deepEqual(redactMcpValue({ apiKey: "abc", nested: { token: "t", keep: "yes" } }), { apiKey: "…", nested: { token: "…", keep: "yes" } })
  assert.equal(redactMcpValue("token=abc"), "token=…", "the secret's value is redacted, not the key")
  assert.equal(redactMcpValue("hello"), "hello")
  assert.equal(redactMcpValue("password=abc"), "password=…")
  assert.equal(redactMcpValue("x".repeat(26)), "…", "a long opaque token is not shown")
  assert.deepEqual(redactMcpValue({ password: "hidden" }), { password: "…" })
  assert.deepEqual(redactMcpValue([0, 1, 2, 3, 4, 5]), [0, 1, 2, 3, 4, 5], "six entries are still all shown")
  assert.equal(Object.keys(redactMcpValue(Object.fromEntries(Array.from({ length: 12 }, (_, index) => ["k" + index, "v"]))) as Record<string, unknown>).length, 12)
  assert.equal(redactMcpValue("Bearer " + "a".repeat(26)), "Bearer …")
  assert.deepEqual(redactMcpValue(Array.from({ length: 8 }, (_, index) => index)), [0, 1, 2, "2 items omitted", 5, 6, 7])
  assert.deepEqual(Object.keys(redactMcpValue(Object.fromEntries(Array.from({ length: 14 }, (_, index) => ["k" + index, "v"]))) as Record<string, unknown>).length, 13)
  assert.deepEqual(redactMcpValue({ a: { b: { c: { d: 1 } } } }), { a: { b: { c: "{…}" } } }, "past a depth it is summarized")
  const thirteenFields = redactMcpValue(Object.fromEntries(Array.from({ length: 13 }, (_, index) => ["f" + index, index]))) as Record<string, unknown>
  assert.equal(thirteenFields["…"], "1 fields omitted")
  assert.equal(thirteenFields.f0, 0)
  assert.equal(thirteenFields.f12, 12)
  assert.equal(summarizeTypedText("Bearer " + "a".repeat(26)), "Enter 33 characters", "the secret's text is not echoed")
  assert.equal(summarizeTypedText("hello"), 'Enter 5 characters (“hello”)')
  assert.equal(summarizeSlateComputerTypedText("hello"), 'Enter 5 characters (“hello”) in Slate\'s hosted workspace')
  const credentialUrl = "https://user:password@example.test/private?token=query-secret#fragment"
  assert.equal(summarizeTypedText(credentialUrl).includes("password"), false)
  assert.equal(summarizeTypedText(credentialUrl).includes("query-secret"), false)
  assert.equal(redactMcpValue(credentialUrl), "https://example.test/private")
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.doesNotThrow(() => redactMcpValue(circular))
  const projected = redactMcpValue({ authorization: "plain", keep: "prefix password=secret" }) as Record<string, unknown>
  assert.deepEqual(projected, { authorization: "…", keep: "prefix password=…" })
})

test("an MCP action is said in words, with a destination hint when there is one", () => {
  assert.equal(humanizeMcpToolAction("send_message"), "send a message")
  assert.equal(humanizeMcpToolAction("send_update"), "send an update")
  assert.equal(humanizeMcpToolAction("archiveChannel"), "archive channel")
  assert.equal(humanizeMcpToolAction("get_user"), "get a user")
  assert.equal(humanizeMcpToolAction(""), undefined)
  assert.equal(safeMcpDestinationHint({ channel: "general" }), "general")
  assert.equal(safeMcpDestinationHint({ channel_id: "word ".repeat(17) }), undefined, "a long destination is not a hint")
  assert.equal(safeMcpDestinationHint({ channel_id: "x".repeat(90) }), undefined, "a secret-shaped destination is not a hint")
  assert.equal(safeMcpDestinationHint({ token: "abc" }), undefined, "a secret is not a destination")
  assert.equal(safeMcpDestinationHint({ path: "/a/b" }), "/a/b")
  assert.equal(safeMcpDestinationHint({ page: "Workspace" }), "Workspace")
  assert.equal(summarizeSlateMcpAutoReviewAction({ serverDisplayName: "Linear", toolName: "create_page", mcpArguments: { title: "Hello" } }).startsWith("Run create_page via Linear with "), true)
  assert.equal(summarizeSlateMcpAutoReviewAction({ serverDisplayName: "Vault", toolName: "create_item", mcpArguments: { token: "top-secret" } }).includes("top-secret"), false)
  assert.equal(mentionsServer("Use NOTION for this", "notion"), true)
  assert.equal(describeSlateMcpAutoReviewAction({ description: "Create a page.", serverDisplayName: "Notion", toolName: "create_page" }), "Create a page. with Notion".replace(". with", " with"))
  assert.equal(describeSlateMcpAutoReviewAction({ description: "Create a page", serverDisplayName: "Notion", toolName: "x" }), "Create a page with Notion")
  assert.equal(describeSlateMcpAutoReviewAction({ description: "Use Notion", serverDisplayName: "Notion", toolName: "x" }), "Use Notion")
  assert.equal(describeSlateMcpAutoReviewAction({ serverDisplayName: "linear", toolName: "get_user", mcpArguments: { channel: "linear" } }), "Ask linear to get a user", "a hint the sentence already names is not repeated")
  assert.equal(fallbackSlateMcpAutoReviewSummary({ serverDisplayName: "", toolName: "", mcpArguments: {} }), "Use a connected service")
})

test("shell, automation, cloud and subagent actions are said as sentences", () => {
  assert.equal(describeSlateShellAutoReviewAction({ surface: "host_shell", description: "Run tests." }), "Run tests on this computer")
  assert.equal(describeSlateShellAutoReviewAction({ surface: "box", workingDirectory: "/w" }), "Start a shell command in Slate's hosted workspace from /w")
  assert.match(summarizeSlateAutomationWriteAction({ operation: "create", name: "R", triggerDescription: "Every day", prompt: "Do work" }), /^Create routine “R” to run every day: “Do work”/)
  assert.match(summarizeSlateAutomationWriteAction({ operation: "update", name: "R", triggerDescription: "on demand", prompt: "p", isEnabled: false }), /paused/)
  assert.match(summarizeSlateAutomationWriteAction({ operation: "workflow_body", name: "W", triggerDescription: "", prompt: "p", referencingRoutineNames: ["a", "b", "c", "d"] }), /used by a, b, c: /)
  assert.equal(summarizeSlateAutomationWriteAction({ operation: "create", name: "R", triggerDescription: "daily", prompt: "token=hidden" }).includes("hidden"), false)
  assert.equal(summarizeSlateCloudAgentAction({ action: "launch", prompt: "do it" }), "Start a cloud agent: “do it”")
  assert.match(summarizeSlateCloudAgentAction({ action: "reply", prompt: "p", agentId: "a", interrupt: true, imageCount: 2 }), /interrupt\) with 2 images/)
  assert.equal(summarizeSlateCloudAgentAction({ action: "launch", prompt: "p", imageCount: 1 }), "Start a cloud agent with 1 image: “p”")
  assert.equal(summarizeSlateCloudAgentAction({ action: "launch", prompt: "token=secret" }).includes("secret"), false)
  assert.equal(summarizeSlateCloudAgentLifecycleAction({ action: "delete", agentId: "a" }), "Delete cloud agent a permanently")
  assert.equal(summarizeSlateCloudAgentLifecycleAction({ action: "unarchive", agentId: "a" }), "Restore cloud agent a to the active list")
  assert.equal(summarizeSlateSubagentAction({ action: "steer", prompt: "p" }), "Send a follow-up to the running task: “p”")
  assert.equal(summarizeSlateSubagentAction({ action: "spawn", prompt: "p" }), "Start a task in Slate's hosted workspace: “p”")
})

test("a browser action names the element, the page and what is being typed", () => {
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "navigate", url: "https://example.com" }), "Navigate to “https://example.com/” in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "click", element: "button", targetPageUrl: "https://example.com" }), "Click “button” on https://example.com/ in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "right_click" }), "Browser action right_click in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "type", text: "hello" }), 'Enter 5 characters (“hello”) in Slate\'s hosted browser')
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "fill", value: "password=hidden" }), "Enter 15 characters in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "press_key", key: "Enter" }), "Press Enter in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "tabs", tabsAction: "close", tabIndex: 2 }), "Close browser tab 2 in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "tabs", tabsAction: "open" }), "Open a browser tab in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "select_option", values: ["one", "two"], element: "menu" }), "Select “one, two” in “menu” in Slate's hosted browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "cdp", cdpMethod: "Page.call", cdpParams: "password=hidden" }).includes("hidden"), false)
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "navigate", url: "https://example.com/?token=hidden" }).includes("hidden"), false)
})
