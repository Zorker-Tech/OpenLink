import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  fromRedactedCoreMessage,
  fromRedactedCoreMessages,
  toRedactedCoreMessage,
  toRedactedCoreMessages,
} from "../../source/packages/redaction/message-redaction.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"

const read = PrivacyCapability.UNSAFE_ALWAYS_ALLOWED

test("a plain user message becomes a redacted one and back again", () => {
  const message = { role: "user", content: "what changed overnight?" }
  const redacted = toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)

  assert.equal(redacted.role, "user")
  assert.equal(redacted._privacyMode, PrivacyMode.NO_STORAGE)
  assert.ok(isRedactedString(redacted.content))
  assert.equal((redacted.content as { __fieldName: string }).__fieldName, "user_content")

  const rebuilt = fromRedactedCoreMessage(redacted, read)
  assert.equal(rebuilt.role, "user")
  assert.equal(rebuilt.content, "what changed overnight?")
})

test("array content is redacted part by part", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "look at this", providerOptions: { hint: "x" } },
      { type: "image", image: "base64-payload", mimeType: "image/png" },
      { type: "file", data: "bytes-here", mimeType: "text/plain" },
    ],
  }
  const redacted = toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)
  const parts = redacted.content as Record<string, unknown>[]
  assert.equal(parts.length, 3)
  assert.equal(parts[0]?.type, "text")
  assert.ok(isRedactedString(parts[0]?.text))
  assert.equal(parts[1]?.type, "image")
  assert.equal(parts[1]?.mimeType, "image/png")
  assert.deepEqual(parts[0]?.providerOptions, { hint: "x" }, "provider options are not private data")

  const rebuilt = fromRedactedCoreMessage(redacted, read)
  const rebuiltParts = rebuilt.content as Record<string, unknown>[]
  assert.equal(rebuiltParts[0]?.text, "look at this")
  assert.equal(rebuiltParts[1]?.image, "base64-payload")
  assert.equal(rebuiltParts[2]?.data, "bytes-here")
})

test("assistant content keeps tool calls and unmodelled parts", () => {
  const message = {
    role: "assistant",
    id: "msg-1",
    content: [
      { type: "text", text: "running it" },
      { type: "tool-call", toolCallId: "call-1", toolName: "shell", args: { command: "ls", flags: ["-l"] } },
      { type: "thinking", text: "not modelled here" },
    ],
  }
  const redacted = toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)
  const parts = redacted.content as Record<string, unknown>[]
  assert.equal(parts[1]?.type, "tool-call")
  assert.ok(isRedactedString(parts[1]?.args))
  assert.equal(parts[2]?.type, "unknown")
  assert.equal(parts[2]?.originalType, "thinking")
  assert.equal(redacted.id, "msg-1", "ids travel with the message")

  const rebuilt = fromRedactedCoreMessage(redacted, read)
  const rebuiltParts = rebuilt.content as Record<string, unknown>[]
  assert.deepEqual(rebuiltParts[1]?.args, { command: "ls", flags: ["-l"] }, "arguments come back as objects")
  assert.deepEqual(rebuiltParts[2], { type: "thinking", text: "not modelled here" })
  assert.equal(rebuilt.id, "msg-1")
})

test("tool results and their experimental content round trip", () => {
  const message = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "shell",
        result: { stdout: "done", code: 0 },
        isError: false,
        experimental_content: [{ type: "text", text: "extra detail" }, { type: "other", keep: true }],
      },
      { type: "tool-result", toolCallId: "call-2", toolName: "read", result: "not json at all" },
    ],
  }
  const redacted = toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)
  const parts = redacted.content as Record<string, unknown>[]
  assert.equal(parts.length, 2)
  assert.ok(isRedactedString(parts[0]?.result))

  const rebuilt = fromRedactedCoreMessage(redacted, read)
  const rebuiltParts = rebuilt.content as Record<string, unknown>[]
  assert.deepEqual(rebuiltParts[0]?.result, { stdout: "done", code: 0 })
  assert.equal(rebuiltParts[0]?.isError, false)
  assert.deepEqual(rebuiltParts[0]?.experimental_content, [
    { type: "text", text: "extra detail" },
    { type: "other", keep: true },
  ])
  assert.equal(rebuiltParts[1]?.result, "not json at all", "a non-JSON result comes back verbatim")
  assert.equal("isError" in rebuiltParts[1]!, false, "an absent flag stays absent")
})

test("system messages are redacted like any other text", () => {
  const redacted = toRedactedCoreMessage({ role: "system", content: "you are helpful" }, PrivacyMode.NO_STORAGE)
  assert.ok(isRedactedString(redacted.content))
  assert.equal((redacted.content as { __fieldName: string }).__fieldName, "system_content")
  assert.equal(fromRedactedCoreMessage(redacted, read).content, "you are helpful")
})

test("a role or part shape this build does not model is refused, not guessed at", () => {
  assert.throws(
    () => toRedactedCoreMessage({ role: "developer", content: "x" }, PrivacyMode.NO_STORAGE),
    /Unhandled CoreMessage role: developer/,
  )
  assert.throws(
    () => toRedactedCoreMessage({ role: "user", content: [{ type: "audio", data: "x" }] }, PrivacyMode.NO_STORAGE),
    /Unhandled user content part type: audio/,
  )
  assert.throws(
    () => fromRedactedCoreMessage({ _privacyMode: 1, role: "developer", content: "x" }, read),
    /Unhandled RedactedCoreMessage role: developer/,
  )
  assert.throws(
    () => fromRedactedCoreMessage({ _privacyMode: 1, role: "user", content: "not redacted" }, read),
    /Expected content parts for a user message/,
  )
})

test("the same message under the same mode is redacted once", () => {
  const message = { role: "user", content: [{ type: "text", text: "hello" }] }
  const first = toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)
  const second = toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)
  assert.equal(first, second, "identity is preserved for downstream caches")
  assert.equal(first.content, second.content, "and so is the redacted content array")

  const otherMode = toRedactedCoreMessage(message, PrivacyMode.NO_TRAINING)
  assert.notEqual(otherMode, first, "a different mode is a different redaction")
  assert.equal(otherMode._privacyMode, PrivacyMode.NO_TRAINING)

  const enforced = toRedactedCoreMessage(message, { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true })
  assert.notEqual(enforced, first, "the gate is part of the cache key")
})

test("lists are redacted element by element", () => {
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
  ]
  const redacted = toRedactedCoreMessages(messages, PrivacyMode.NO_STORAGE)
  assert.equal(redacted.length, 2)
  assert.deepEqual(fromRedactedCoreMessages(redacted, read).map(message => message.content), ["one", "two"])
})

test("an enforced message refuses to be rebuilt for a purpose it forbids", () => {
  const message = { role: "user", content: "private plan" }
  const redacted = toRedactedCoreMessage(message, { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true })

  assert.throws(
    () => fromRedactedCoreMessage(redacted, PrivacyCapability.STORAGE_FOR_TRAINING),
    /Unwrap not allowed for purpose storage_for_training/,
  )
  assert.equal(
    fromRedactedCoreMessage(redacted, PrivacyCapability.STORAGE_FOR_TRAINING, {
      redactUnallowedFieldsInsteadOfThrowing: true,
    }).content,
    "[redacted:user_content]",
  )
  assert.equal(
    fromRedactedCoreMessage(redacted, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content,
    "private plan",
    "the escape hatch still reads it",
  )
})

test("a private field name survives the round trip, so the placeholder points at it", () => {
  const redacted = toRedactedCoreMessage(
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "shell", args: { secret: "x" } }] },
    { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true },
  )
  const parts = redacted.content as Record<string, unknown>[]
  assert.equal(
    (parts[0]?.args as { __fieldName: string }).__fieldName,
    "tool_call_args",
    "the placeholder names the field a reader should look at",
  )
})

test("development refuses implicit serialization instead of reporting it", () => {
  const entry = new URL("../../source/packages/redaction/create.ts", import.meta.url).href
  const script = `
import { createRedactedString } from ${JSON.stringify(entry)}
const value = createRedactedString("secret", "credentials", "token", 1)
try {
  String(value)
  console.log("NO-THROW")
} catch (error) {
  console.log("THREW " + error.message)
}
`
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" }
  delete environment.NODE_TEST_CONTEXT
  const output = execFileSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script],
    { env: environment, encoding: "utf8" },
  )
  assert.match(output, /THREW/)
  assert.match(output, /implicit serialization/)
  assert.match(output, /field=token/)
})

test("production reports the same serialization instead of throwing", () => {
  const entry = new URL("../../source/packages/redaction/create.ts", import.meta.url).href
  const violations = new URL("../../source/packages/redaction/violations.ts", import.meta.url).href
  const script = `
import { createRedactedString } from ${JSON.stringify(entry)}
import { setRedactionLogger } from ${JSON.stringify(violations)}
const seen = []
setRedactionLogger({ info: (attributes, message) => seen.push({ attributes, message }) })
const value = createRedactedString("secret", "credentials", "token", 1)
console.log("VALUE " + String(value) + " VIOLATIONS " + seen.length + " " + seen[0].message)
`
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" }
  delete environment.NODE_TEST_CONTEXT
  const output = execFileSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script],
    { env: environment, encoding: "utf8" },
  )
  assert.match(output, /VALUE secret/, "without enforcement the raw value is what a print shows")
  assert.match(output, /VIOLATIONS 1/)
  assert.match(output, /implicit serialization/)
})

test("the private classification never reaches a printed message", () => {
  const redacted = toRedactedCoreMessage(
    { role: "user", content: "card number 4111" },
    { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true },
  )
  const printed = String(redacted.content)
  assert.equal(printed, "[redacted:user_content]")
  assert.equal(JSON.stringify(redacted.content), '"[redacted:user_content]"')
  assert.equal(printed.includes("4111"), false)
  assert.equal(redacted._privacyMode, PrivacyMode.NO_STORAGE, "only the mode travels with the message")
  assert.equal(Object.values(redacted).includes(DataClassification.CREDENTIALS), false)
})
