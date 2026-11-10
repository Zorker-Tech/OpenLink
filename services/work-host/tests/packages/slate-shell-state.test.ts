import assert from "node:assert/strict"
import test from "node:test"

import {
  shellInvocationToRunner,
  shellResultToRunner,
} from "../../source/adapters/interop/agent/shell-state-projection-adapter.ts"
import {
  createSlateShellInvocationSerde,
  createSlateShellResultSerde,
} from "../../source/adapters/storage/agent/shell-state-storage-adapter.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import {
  createSlateShellInvocation,
  createSlateShellResult,
  storeSlateShellInvocation,
  storeSlateShellResult,
} from "../../source/packages/agent/shell-state.ts"

const invocationSerde = (privacyMode = PrivacyMode.NO_STORAGE) =>
  createSlateShellInvocationSerde(privacyMode)
const resultSerde = (privacyMode = PrivacyMode.NO_STORAGE) =>
  createSlateShellResultSerde(privacyMode)

test("Slate shell invocation writes a versioned owned record and reapplies privacy on read", () => {
  const value = storeSlateShellInvocation(createSlateShellInvocation("pwd && ls"), PrivacyMode.NO_STORAGE)
  const serde = invocationSerde()
  const bytes = serde.serialize(value)
  const json = new TextDecoder().decode(bytes)
  assert.ok(json.startsWith("SLATE-AGENT-SHELL-INVOCATION\n"))
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-shell-invocation" })

  const stored = JSON.parse(json.slice("SLATE-AGENT-SHELL-INVOCATION\n".length)) as {
    readonly format: string
    readonly version: number
    readonly invocation: { readonly commandText: { readonly text: string; readonly fieldName: string } }
  }
  assert.equal(stored.format, "slate.agent-shell-invocation")
  assert.equal(stored.version, 1)
  assert.equal(stored.invocation.commandText.text, "pwd && ls")
  assert.equal(stored.invocation.commandText.fieldName, "command")

  const restored = serde.deserialize(bytes)
  assert.ok(restored.commandText instanceof RedactedString)
  assert.equal(restored.commandText.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "pwd && ls")
  assert.equal(restored.commandText.__classification, DataClassification.CODE)
  assert.equal(restored.commandText.__privacyMode, PrivacyMode.NO_STORAGE)
})

test("Slate shell results preserve separate streams and the process exit status", () => {
  const value = storeSlateShellResult(
    createSlateShellResult({ standardOutput: "ok\n", standardError: "warning\n", exitCode: 7 }),
    PrivacyMode.NO_STORAGE,
  )
  const serde = resultSerde()
  const bytes = serde.serialize(value)
  const json = new TextDecoder().decode(bytes)
  assert.ok(json.startsWith("SLATE-AGENT-SHELL-RESULT\n"))
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-shell-result" })

  const restored = serde.deserialize(bytes)
  assert.ok(restored.standardOutput instanceof RedactedString)
  assert.ok(restored.standardError instanceof RedactedString)
  assert.equal(restored.standardOutput.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "ok\n")
  assert.equal(restored.standardError.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "warning\n")
  assert.equal(restored.standardOutput.__fieldName, "stdout")
  assert.equal(restored.standardError.__fieldName, "stderr")
  assert.equal(restored.exitCode, 7)
})

test("Slate shell state projects into the runner's shell messages", () => {
  const command = shellInvocationToRunner(invocationSerde().deserialize(invocationSerde().serialize(
    storeSlateShellInvocation(createSlateShellInvocation("echo slate"), PrivacyMode.NO_STORAGE),
  )))
  assert.equal(command.command, "echo slate")

  const result = shellResultToRunner(resultSerde().deserialize(resultSerde().serialize(
    storeSlateShellResult(createSlateShellResult({
      standardOutput: "out",
      standardError: "err",
      exitCode: -2,
    }), PrivacyMode.NO_STORAGE),
  )))
  assert.equal(result.stdout, "out")
  assert.equal(result.stderr, "err")
  assert.equal(result.exitCode, -2)
})

test("malformed versioned shell data is rejected", () => {
  assert.throws(
    () => invocationSerde().deserialize(new TextEncoder().encode("SLATE-AGENT-SHELL-INVOCATION\n{")),
    /not valid JSON/,
  )
  assert.throws(
    () => resultSerde().deserialize(new TextEncoder().encode("SLATE-AGENT-SHELL-RESULT\n{}")),
    /envelope is invalid/,
  )
  assert.throws(
    () => resultSerde().deserialize(new TextEncoder().encode("not-a-slate-shell-result")),
    /unsupported/,
  )
  assert.throws(
    () => createSlateShellResult({ standardOutput: "", standardError: "", exitCode: 2_147_483_648 }),
    /signed 32-bit integer/,
  )
})
