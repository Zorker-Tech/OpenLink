import { test } from "node:test"
import assert from "node:assert/strict"

import path from "node:path"

import { createContext } from "../../source/packages/context/context.ts"
import { READ_LINT_TIMEOUT_MS, configOverridesKey, overridableConfig } from "../../source/packages/agent/utils/config-overrides.ts"
import { getInvocationId, getInvocationIdFromRequestId, invocationIdGeneratorKey } from "../../source/packages/agent/utils/invocation-id.ts"
import { MCP_AUTH_INSTRUCTION } from "../../source/packages/agent/utils/mcp-auth-instruction.ts"
import { buildCurrentModeStatement } from "../../source/packages/agent/utils/mode-guidance.ts"
import {
  META_PARENT_COMPLETION_CLOSE_TAG,
  META_PARENT_COMPLETION_OPEN_TAG,
  META_PARENT_COMPLETION_SYSTEM_REMINDER,
  META_PARENT_COMPLETION_TAG,
} from "../../source/packages/agent/utils/notification-protocol.ts"
import { escapePromptXmlText } from "../../source/packages/agent/utils/prompt-xml-escape.ts"
import { getRequestPathModule } from "../../source/packages/agent/utils/request-paths.ts"
import { formatSlackSenderLine } from "../../source/packages/agent/utils/slack-sender.ts"
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

test("a sender line names who sent the message, with the id when there is one", () => {
  assert.equal(
    formatSlackSenderLine("Ada", "U1", "user"),
    "The current message is being sent by Ada (U1) (user)",
  )
  assert.equal(formatSlackSenderLine("Ada", undefined), "The current message is being sent by Ada")
  assert.equal(formatSlackSenderLine(undefined, "U1"), "The current message is being sent by U1")
  assert.equal(formatSlackSenderLine("Ada", "U1"), "The current message is being sent by Ada (U1)")
  assert.equal(formatSlackSenderLine("  ", "  "), undefined)
  assert.equal(formatSlackSenderLine(undefined, undefined), undefined)
  assert.equal(formatSlackSenderLine(" Ada ", " U1 ", " bot "), "The current message is being sent by Ada (U1) (bot)")
})

test("a mode change says the old mode has ended", () => {
  assert.equal(
    buildCurrentModeStatement("plan", [], []),
    "You are now in Plan mode. You have EXITED your previous mode. Continue with the task in the new mode.",
  )
  assert.match(buildCurrentModeStatement("chat", [], []), /You are now in Ask mode/)
  assert.match(buildCurrentModeStatement("custom-mode", [], []), /You are now in custom-mode mode/)
})

test("configuration is read from the context, with the default when nothing overrides it", () => {
  const ctx = createContext()
  assert.equal(READ_LINT_TIMEOUT_MS(ctx), 10_000)

  const overridden = ctx.with(configOverridesKey, { read_lint_timeout_ms: 250 })
  assert.equal(READ_LINT_TIMEOUT_MS(overridden), 250)
  assert.equal(READ_LINT_TIMEOUT_MS(ctx), 10_000, "the override belongs to that context only")

  const flag = overridableConfig("missingKey", "fallback")
  assert.equal(flag(ctx), "fallback")
  const withFalse = ctx.with(configOverridesKey, { missingKey: false })
  assert.equal(flag(withFalse), false, "a false override is a value, not an absence")
  const withNull = ctx.with(configOverridesKey, { missingKey: null })
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
  assert.match(MCP_AUTH_INSTRUCTION, /call `mcp_auth`/)
  assert.match(MCP_AUTH_INSTRUCTION, /Do not call `mcp_auth` just because it is listed/)
  assert.match(MCP_AUTH_INSTRUCTION, /Do not call `mcp_auth` in parallel/)
  assert.match(MCP_AUTH_INSTRUCTION, /inspect that server again/)
})
