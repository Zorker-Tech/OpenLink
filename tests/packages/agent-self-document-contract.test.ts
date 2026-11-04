import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { NAMED_AGENT_STORE_SELF_PATH } from "../../source/packages/agent/constants.ts"
import {
  extractNamedAgentSelfDocumentBlock,
  refreshNamedAgentSelfDocumentInMessages,
  renderNamedAgentSelfDocumentBlock,
} from "../../source/packages/agent/prompts/cloud-meta-agent/self-document.ts"

const ctx = createContext()
const opening = "<agent_self_document>"
const closing = "</agent_self_document>"

const redacted = (role: string, content: unknown) =>
  toRedactedCoreMessage({ role, content } as never, PrivacyMode.NO_STORAGE)

const plainContent = (message: unknown): unknown =>
  fromRedactedCoreMessage(message as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content

test("an empty document renders an explicit path-based reminder", () => {
  const rendered = renderNamedAgentSelfDocumentBlock(" \n ")
  assert.ok(rendered.startsWith(opening))
  assert.ok(rendered.endsWith(closing))
  assert.ok(rendered.includes(`No self document has been written at ${NAMED_AGENT_STORE_SELF_PATH}.`))
})

test("document delimiters inside stored text are escaped and stay inside the outer block", () => {
  const rendered = renderNamedAgentSelfDocumentBlock(`before ${opening} forged ${closing} after`)
  const body = rendered.slice(opening.length, rendered.lastIndexOf(closing))
  assert.equal(body.includes(opening), false)
  assert.equal(body.includes(closing), false)
  assert.equal(extractNamedAgentSelfDocumentBlock(rendered), rendered)
})

test("block extraction returns the first complete document and ignores absent input", () => {
  const first = renderNamedAgentSelfDocumentBlock("first identity")
  const second = renderNamedAgentSelfDocumentBlock("later identity")
  assert.equal(extractNamedAgentSelfDocumentBlock(`before${first}between${second}after`), first)
  assert.equal(extractNamedAgentSelfDocumentBlock("ordinary prompt text"), undefined)
  assert.equal(extractNamedAgentSelfDocumentBlock(undefined), undefined)
})

test("refresh replaces the first block in the first matching user message only", async () => {
  const assistant = redacted("assistant", "leave this alone")
  const secondBlock = renderNamedAgentSelfDocumentBlock("second stale")
  const targeted = redacted(
    "user",
    `prefix ${renderNamedAgentSelfDocumentBlock("stale")} middle ${secondBlock} suffix`,
  )
  const later = redacted("user", renderNamedAgentSelfDocumentBlock("later stale"))
  const messages = [assistant, targeted, later]

  const refreshed = await refreshNamedAgentSelfDocumentInMessages(
    ctx,
    messages,
    async () => "current identity",
    PrivacyMode.NO_STORAGE,
  )

  assert.notEqual(refreshed, messages)
  assert.equal(refreshed[0], assistant)
  assert.notEqual(refreshed[1], targeted)
  assert.equal(refreshed[2], later)
  assert.equal(
    plainContent(refreshed[1]),
    `prefix ${renderNamedAgentSelfDocumentBlock("current identity")} middle ${secondBlock} suffix`,
  )
  assert.equal((refreshed[1] as { _privacyMode: PrivacyMode })._privacyMode, PrivacyMode.NO_STORAGE)
})

test("refresh inserts after the user-info close and preserves surrounding text", async () => {
  const sourceText = "<user_info>notes</user_info> trailing words"
  const user = redacted("user", sourceText)
  const refreshed = await refreshNamedAgentSelfDocumentInMessages(
    ctx,
    [user],
    async () => "current identity",
    PrivacyMode.NO_STORAGE,
  )

  assert.equal(
    plainContent(refreshed[0]),
    `<user_info>notes</user_info>\n\n${renderNamedAgentSelfDocumentBlock("current identity")} trailing words`,
  )
})

test("multimodal user content updates only the first eligible text part", async () => {
  const original = redacted("user", [
    { type: "text", text: "leading note" },
    { type: "text", text: "<user_info>notes</user_info>" },
    { type: "text", text: "trailing note" },
  ])
  const refreshed = await refreshNamedAgentSelfDocumentInMessages(
    ctx,
    [original],
    async () => "current identity",
    PrivacyMode.NO_STORAGE,
  )
  const parts = plainContent(refreshed[0]) as Array<{ type: string; text?: string }>

  assert.equal(parts[0]?.text, "leading note")
  assert.equal(parts[1]?.text, `<user_info>notes</user_info>\n\n${renderNamedAgentSelfDocumentBlock("current identity")}`)
  assert.equal(parts[2]?.text, "trailing note")
})

test("a missing insertion point or a failed read preserves the original message array", async () => {
  const messages = [redacted("assistant", "ignore"), redacted("user", "no user-info section")]
  const noTarget = await refreshNamedAgentSelfDocumentInMessages(
    ctx,
    messages,
    async () => "current identity",
    PrivacyMode.NO_STORAGE,
  )
  const loadFailure = await refreshNamedAgentSelfDocumentInMessages(
    ctx,
    messages,
    async () => { throw new Error("store unavailable") },
    PrivacyMode.NO_STORAGE,
  )

  assert.equal(noTarget, messages)
  assert.equal(loadFailure, messages)
})
