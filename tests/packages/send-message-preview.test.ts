import assert from "node:assert/strict"
import { test } from "node:test"

import {
  connectorsPreviewText,
  sendMessagePreviewText,
  SLATE_AGENT_FALLBACK_PREVIEW,
  slateAgentPreviewText,
} from "../../source/shared/send-message-preview.ts"
import type { SendMessagePreviewInput } from "../../source/shared/send-message-preview.ts"

test("agent and connector labels have stable fallbacks", () => {
  assert.equal(slateAgentPreviewText("  Build report  "), "Slate agent: Build report")
  assert.equal(slateAgentPreviewText(undefined), SLATE_AGENT_FALLBACK_PREVIEW)
  assert.equal(slateAgentPreviewText("   "), SLATE_AGENT_FALLBACK_PREVIEW)
  assert.equal(connectorsPreviewText(["Drive", "Calendar"]), "Connect Drive, Calendar")
  assert.equal(connectorsPreviewText([]), "Connect tools")
})

test("every message kind projects the summary line its recipient expects", () => {
  const examples: readonly (readonly [SendMessagePreviewInput, string])[] = [
    [{ type: "text", content: "hello" }, "hello"],
    [{ type: "attachment", url: "https://files.example/item" }, "https://files.example/item"],
    [{ type: "widget", widget: { prompt: "Choose one" } }, "Choose one"],
    [{ type: "slate-agent", title: "Agent task" }, "Slate agent: Agent task"],
    [{ type: "slate-agent" }, SLATE_AGENT_FALLBACK_PREVIEW],
    [{ type: "secret-request", secretRequest: { label: "Provide a token" } }, "Provide a token"],
    [{ type: "email-draft", draft: { subject: "Subject", body: "Body" } }, "Subject"],
    [{ type: "email-draft", draft: { subject: "", body: "Body" } }, "Body"],
    [{ type: "slack-draft", draft: { body: "Draft text" } }, "Draft text"],
    [{ type: "permission-request", permission: { title: "Approve command" } }, "Approve command"],
    [{ type: "auto-review-approval", approval: { summary: "Review changes" } }, "Approval required: Review changes"],
    [{ type: "local-tool-permission", ask: { target: "run formatter" } }, "Permission required: run formatter"],
    [{ type: "connector", variant: "connected", connector: "Drive" }, "Drive connected"],
    [{ type: "connector", variant: "available", connector: "Calendar" }, "Connect Calendar"],
    [{ type: "connectors", connectors: ["Drive", "Calendar"] }, "Connect Drive, Calendar"],
    [{ type: "connectors", connectors: [] }, "Connect tools"],
    [{ type: "listener-connect", platform: "slack" }, "Connect Slack"],
    [{ type: "listener-connect", platform: "github" }, "Connect GitHub"],
  ]

  for (const [input, expected] of examples) {
    assert.equal(sendMessagePreviewText(input), expected, input.type)
  }
  assert.equal(sendMessagePreviewText({ type: "unknown" } as never), "Message")
})
