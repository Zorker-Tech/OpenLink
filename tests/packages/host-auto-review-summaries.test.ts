import { test } from "node:test"
import assert from "node:assert/strict"

import {
  compact,
  compactHeadAndTail,
  describeSlateMcpAutoReviewAction,
  describeSlateShellAutoReviewAction,
  humanizeMcpToolAction,
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
  assert.equal(tail, "xxxxxxxxxxxxxxxxxxxx…[461 chars omitted]…xxxxxxxxxxxxxxxxxxx")
  assert.equal(tail.length <= 60, true)
  assert.equal(compactHeadAndTail("a", 5), "a")
})

test("secrets are redacted before a value is shown", () => {
  assert.deepEqual(redactMcpValue({ apiKey: "abc", nested: { token: "t", keep: "yes" } }), { apiKey: "…", nested: { token: "…", keep: "yes" } })
  assert.equal(redactMcpValue("token=abc"), "token=…", "the secret's value is redacted, not the key")
  assert.equal(redactMcpValue("hello"), "hello")
  assert.equal(redactMcpValue("password=abc"), "password=…")
  assert.deepEqual(redactMcpValue([0, 1, 2, 3, 4, 5]), [0, 1, 2, 3, 4, 5], "six entries are still all shown")
  assert.equal(Object.keys(redactMcpValue(Object.fromEntries(Array.from({ length: 12 }, (_, index) => ["k" + index, "v"]))) as Record<string, unknown>).length, 12)
  assert.equal(redactMcpValue("Bearer " + "a".repeat(26)), "…")
  assert.deepEqual(redactMcpValue(Array.from({ length: 8 }, (_, index) => index)), [0, 1, 2, "2 items omitted", 5, 6, 7])
  assert.deepEqual(Object.keys(redactMcpValue(Object.fromEntries(Array.from({ length: 14 }, (_, index) => ["k" + index, "v"]))) as Record<string, unknown>).length, 13)
  assert.deepEqual(redactMcpValue({ a: { b: { c: { d: 1 } } } }), { a: { b: { c: "{…}" } } }, "past a depth it is summarized")
  assert.equal(summarizeTypedText("Bearer " + "a".repeat(26)), "Type 33 characters", "the secret's text is not echoed")
  assert.equal(summarizeTypedText("hello"), 'Type 5 characters (“hello”)')
  assert.equal(summarizeSlateComputerTypedText("hello"), 'Type 5 characters (“hello”) on Slate\'s computer')
})

test("an MCP action is said in words, with a destination hint when there is one", () => {
  assert.equal(humanizeMcpToolAction("send_message"), "send a message")
  assert.equal(humanizeMcpToolAction("send_update"), "send an update")
  assert.equal(humanizeMcpToolAction("archiveChannel"), "archive channel")
  assert.equal(humanizeMcpToolAction(""), undefined)
  assert.equal(safeMcpDestinationHint({ channel: "general" }), "general")
  assert.equal(safeMcpDestinationHint({ channel_id: "word ".repeat(17) }), undefined, "a long destination is not a hint")
  assert.equal(safeMcpDestinationHint({ channel_id: "x".repeat(90) }), undefined, "a secret-shaped destination is not a hint")
  assert.equal(safeMcpDestinationHint({ token: "abc" }), undefined, "a secret is not a destination")
  assert.equal(safeMcpDestinationHint({ path: "/a/b" }), "/a/b")
  assert.equal(summarizeSlateMcpAutoReviewAction({ serverDisplayName: "Linear", toolName: "create_page", mcpArguments: { title: "Hello" } }).startsWith("Use Linear tool create_page with "), true)
  assert.equal(describeSlateMcpAutoReviewAction({ description: "Create a page.", serverDisplayName: "Notion", toolName: "create_page" }), "Create a page. with Notion".replace(". with", " with"))
  assert.equal(describeSlateMcpAutoReviewAction({ description: "Create a page", serverDisplayName: "Notion", toolName: "x" }), "Create a page with Notion")
  assert.equal(describeSlateMcpAutoReviewAction({ description: "Use Notion", serverDisplayName: "Notion", toolName: "x" }), "Use Notion")
  assert.equal(describeSlateMcpAutoReviewAction({ serverDisplayName: "linear", toolName: "get_user", mcpArguments: { channel: "linear" } }), "Use linear to get an user", "a hint the sentence already names is not repeated")
})

test("shell, automation, cloud and subagent actions are said as sentences", () => {
  assert.equal(describeSlateShellAutoReviewAction({ surface: "host_shell", description: "Run tests." }), "Run tests on your local computer")
  assert.equal(describeSlateShellAutoReviewAction({ surface: "box", workingDirectory: "/w" }), "Run a command on Slate\'s computer from /w")
  assert.match(summarizeSlateAutomationWriteAction({ operation: "create", name: "R", triggerDescription: "Every day", prompt: "Do work" }), /^Save the routine “R” to run every day: “Do work”/)
  assert.match(summarizeSlateAutomationWriteAction({ operation: "update", name: "R", triggerDescription: "on demand", prompt: "p", isEnabled: false }), /^\(paused\)|paused/)
  assert.match(summarizeSlateAutomationWriteAction({ operation: "workflow_body", name: "W", triggerDescription: "", prompt: "p", referencingRoutineNames: ["a", "b", "c", "d"] }), /used by a, b, c: /)
  assert.equal(summarizeSlateCloudAgentAction({ action: "launch", prompt: "do it" }), "Launch a cloud agent: “do it”")
  assert.match(summarizeSlateCloudAgentAction({ action: "reply", prompt: "p", agentId: "a", interrupt: true, imageCount: 2 }), /interrupt\) with 2 attached images/)
  assert.match(summarizeSlateCloudAgentAction({ action: "launch", prompt: "p", imageCount: 1 }), /with 1 attached image it can see/)
  assert.equal(summarizeSlateCloudAgentLifecycleAction({ action: "delete", agentId: "a" }), "Permanently delete cloud agent a")
  assert.equal(summarizeSlateSubagentAction({ action: "steer", prompt: "p" }), "Send a follow-up to a running task: “p”")
})

test("a browser action names the element, the page and what is being typed", () => {
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "navigate", url: "https://example.com" }), "Open “https://example.com” in the box browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "click", element: "button", targetPageUrl: "https://example.com" }), "Click “button” on https://example.com in the box browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "right_click" }), "Browser right_click on Slate\'s computer")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "type", text: "hello" }), 'Type 5 characters (“hello”) in the box browser')
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "press_key", key: "Enter" }), "Press Enter in the box browser")
  assert.equal(summarizeSlateBrowserAutoReviewAction({ op: "tabs", tabsAction: "close", tabIndex: 2 }), "Close browser tab 2 in the box browser")
})
