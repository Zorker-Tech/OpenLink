import { test } from "node:test"
import assert from "node:assert/strict"

import path from "node:path"

import { createContext } from "../../source/packages/context/context.ts"
import { READ_LINT_TIMEOUT_MS } from "../../source/packages/agent/utils/config-overrides.ts"
import { readContextOverride, slateConfigOverridesKey } from "../../source/packages/agent/utils/config-override-reader.ts"
import { getInvocationId, getInvocationIdFromRequestId, invocationIdGeneratorKey } from "../../source/packages/agent/utils/invocation-id.ts"
import { MCP_AUTH_INSTRUCTION } from "../../source/packages/agent/utils/mcp-auth-instruction.ts"
import { describeModeSwitch } from "../../source/packages/agent/utils/mode-switch-reminder.ts"
import {
  META_PARENT_COMPLETION_CLOSE_TAG,
  META_PARENT_COMPLETION_OPEN_TAG,
  META_PARENT_COMPLETION_SYSTEM_REMINDER,
  META_PARENT_COMPLETION_TAG,
} from "../../source/packages/agent/utils/notification-protocol.ts"
import { escapePromptXmlText } from "../../source/packages/agent/utils/prompt-xml-escape.ts"
import { getRequestPathModule } from "../../source/packages/agent/utils/request-paths.ts"
import { formatInvocationSenderLine } from "../../source/packages/agent/context/invocation-platforms.ts"
import {
  METADATA_MARKER,
  parseSmartModeClassifierFailureMetadata,
  SMART_MODE_CLASSIFIER_MANUAL_REVIEW_ERROR_REASON,
} from "../../source/packages/agent/utils/smart-mode-error-metadata.ts"
import { estimateStringTokenCount } from "../../source/packages/agent/utils/token-estimate.ts"

test("prompt text is escaped so a value cannot look like a tag", () => {
  assert.equal(escapePromptXmlText("a < b & c > d"), "a &lt; b &amp; c &gt; d")
  assert.equal(escapePromptXmlText("plain"), "plain")
  assert.equal(escapePromptXmlText("<section>"), "&lt;section&gt;")
})

test("a token count is estimated from the string length", () => {
  assert.equal(estimateStringTokenCount(""), 0)
  assert.deepEqual(
    Array.from({ length: 9 }, (_, size) => estimateStringTokenCount("x".repeat(size))),
    [0, 0, 1, 1, 1, 1, 2, 2, 2],
  )
  assert.equal(estimateStringTokenCount("abcd"), 1)
  assert.equal(estimateStringTokenCount("abcde"), 1)
  assert.equal(estimateStringTokenCount("a".repeat(400)), 100)
})

test("path handling follows the environment the request runs in", () => {
  assert.equal(getRequestPathModule({ env: { osVersion: "Windows 11 win32" } }), path.win32)
  assert.equal(getRequestPathModule({ env: { osVersion: "Linux 6.1" } }), path.posix)
  assert.equal(getRequestPathModule({}), path.posix)
  assert.equal(getRequestPathModule({ env: {} }), path.posix)
})

test("a subagent notification is delimited and comes with its reminder", () => {
  assert.equal(META_PARENT_COMPLETION_TAG, "agent_notification")
  assert.equal(META_PARENT_COMPLETION_OPEN_TAG, "<agent_notification>")
  assert.equal(META_PARENT_COMPLETION_CLOSE_TAG, "</agent_notification>")
  assert.match(META_PARENT_COMPLETION_SYSTEM_REMINDER, /Do not reiterate or repeat/)
  assert.match(META_PARENT_COMPLETION_SYSTEM_REMINDER, /Handling subagent notifications/)
})

test("the delimiters are the tag between angle brackets, and the reminder is five lines with a blank one between", () => {
  assert.equal(META_PARENT_COMPLETION_OPEN_TAG, `<${META_PARENT_COMPLETION_TAG}>`)
  assert.equal(META_PARENT_COMPLETION_CLOSE_TAG, `</${META_PARENT_COMPLETION_TAG}>`)
  assert.equal(META_PARENT_COMPLETION_SYSTEM_REMINDER.startsWith("<system_reminder>\n"), true)
  assert.equal(META_PARENT_COMPLETION_SYSTEM_REMINDER.endsWith("\n</system_reminder>"), true)
  const lines = META_PARENT_COMPLETION_SYSTEM_REMINDER.split("\n")
  assert.equal(lines.length, 5)
  assert.equal(lines[0], "<system_reminder>")
  assert.equal(lines[2], "", "a blank line separates the instruction from the reminder of what to follow")
  assert.equal(lines[4], "</system_reminder>")
  assert.match(lines[1] ?? "", /^Do not reiterate or repeat the contents of this agent notification to the user unless asked to do so\.$/)
  assert.match(lines[3] ?? "", /^Follow your instructions for Handling subagent notifications\.$/)
})

test("classification failure metadata is read out of the error text when it is there", () => {
  const error = `${SMART_MODE_CLASSIFIER_MANUAL_REVIEW_ERROR_REASON}${METADATA_MARKER}${JSON.stringify({ failureReason: "provider overloaded", retryable: true })}`
  assert.deepEqual(parseSmartModeClassifierFailureMetadata(error), { failureReason: "provider overloaded", retryable: true })

  assert.deepEqual(
    parseSmartModeClassifierFailureMetadata(`${METADATA_MARKER}{"retryable":false}`),
    { failureReason: undefined, retryable: false },
  )
  assert.equal(parseSmartModeClassifierFailureMetadata("just an error"), undefined)
  assert.equal(parseSmartModeClassifierFailureMetadata(undefined), undefined)
  assert.equal(parseSmartModeClassifierFailureMetadata(`${METADATA_MARKER}not json`), undefined)
  assert.equal(parseSmartModeClassifierFailureMetadata(`${METADATA_MARKER}"a string"`), undefined)
  assert.equal(parseSmartModeClassifierFailureMetadata(`${METADATA_MARKER}null`), undefined)
})

test("an invocation sender line names who sent the message, with the id when there is one", () => {
  assert.equal(
    formatInvocationSenderLine("Ada", "U1", "user"),
    "The current message is being sent by Ada (U1) (user)",
  )
  assert.equal(formatInvocationSenderLine("Ada", undefined), "The current message is being sent by Ada")
  assert.equal(formatInvocationSenderLine(undefined, "U1"), "The current message is being sent by U1")
  assert.equal(formatInvocationSenderLine("Ada", "U1"), "The current message is being sent by Ada (U1)")
  assert.equal(formatInvocationSenderLine("  ", "  "), undefined)
  assert.equal(formatInvocationSenderLine(undefined, undefined), undefined)
  assert.equal(formatInvocationSenderLine(" Ada ", " U1 ", " bot "), "The current message is being sent by Ada (U1) (bot)")
})

test("a mode change says the old mode has ended", () => {
  assert.equal(
    describeModeSwitch("plan"),
    "You are now in Plan mode. You have EXITED your previous mode. Continue with the task in the new mode.",
  )
  assert.match(describeModeSwitch("chat"), /You are now in Ask mode/)
  assert.match(describeModeSwitch("custom-mode"), /You are now in custom-mode mode/)
  assert.match(describeModeSwitch("toString"), /You are now in toString mode/)
})

test("configuration is read from the context, with the default when nothing overrides it", () => {
  const ctx = createContext()
  assert.equal(READ_LINT_TIMEOUT_MS(ctx), 10_000)

  const overridden = ctx.with(slateConfigOverridesKey, { read_lint_timeout_ms: 250 })
  assert.equal(READ_LINT_TIMEOUT_MS(overridden), 250)
  assert.equal(READ_LINT_TIMEOUT_MS(ctx), 10_000, "the override belongs to that context only")

  const flag = readContextOverride("missingKey", "fallback")
  assert.equal(flag(ctx), "fallback")
  const withFalse = ctx.with(slateConfigOverridesKey, { missingKey: false })
  assert.equal(flag(withFalse), false, "a false override is a value, not an absence")
  const withNull = ctx.with(slateConfigOverridesKey, { missingKey: null })
  assert.equal(flag(withNull), "fallback", "an explicit null falls back")
})

test("invocation ids distinguish runs of the same request", () => {
  const requestId = `req-${Math.random().toString(36).slice(2)}`
  const first = getInvocationIdFromRequestId(requestId)
  const second = getInvocationIdFromRequestId(requestId)
  assert.match(first, new RegExp(`^${requestId}-0-[a-z0-9]{4}$`))
  assert.match(second, new RegExp(`^${requestId}-1-[a-z0-9]{4}$`))
  assert.notEqual(first, second)
  assert.notEqual(
    getInvocationIdFromRequestId("other-request").split("-").at(-1),
    undefined,
    "another request has its own counter",
  )

  const ctx = createContext()
  assert.match(getInvocationId(ctx), /^[0-9a-f-]{36}$/, "the default generator makes a uuid")
  const predictable = ctx.with(invocationIdGeneratorKey, () => "fixed-id")
  assert.equal(getInvocationId(predictable), "fixed-id")
})

test("the MCP authentication instruction carries the whole policy", () => {
  assert.match(MCP_AUTH_INSTRUCTION, /`mcp_auth` only after a server requests sign-in or an MCP call reports an authorization failure/)
  assert.match(MCP_AUTH_INSTRUCTION, /Authenticate one server at a time/)
  assert.match(MCP_AUTH_INSTRUCTION, /check that server's state once the flow completes/)
  assert.match(MCP_AUTH_INSTRUCTION, /repeat the original call if the credentials resolved the problem/)
  assert.match(MCP_AUTH_INSTRUCTION, /Skip authentication for servers that are merely present in the list/)
  assert.match(MCP_AUTH_INSTRUCTION, /if the flow fails, stop instead of prompting again/)
})
