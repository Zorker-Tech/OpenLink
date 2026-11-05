import assert from "node:assert/strict"
import test from "node:test"

import { ShellCommand, ShellOutput } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  importLegacyShellInvocation,
  importLegacyShellResult,
  shellInvocationToRunner,
  shellResultToRunner,
} from "../../source/adapters/interop/agent/legacy-shell-state-adapter.ts"
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
  createSlateShellInvocationSerde(privacyMode, importLegacyShellInvocation)
const resultSerde = (privacyMode = PrivacyMode.NO_STORAGE) =>
  createSlateShellResultSerde(privacyMode, importLegacyShellResult)

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

test("historical shell messages import, upgrade, and project with unknown fields intact", () => {
  const oldCommand = new ShellCommand({ command: "echo retained" })
  ShellCommand.runtime.bin.onUnknownField(oldCommand, 100, 0, new Uint8Array([7]))
  const oldOutput = new ShellOutput({ stdout: "out", stderr: "err", exitCode: -2 })
  ShellOutput.runtime.bin.onUnknownField(oldOutput, 101, 0, new Uint8Array([8]))

  const commandStorage = invocationSerde()
  const resultStorage = resultSerde()
  const importedCommand = commandStorage.deserialize(oldCommand.toBinary())
  const importedResult = resultStorage.deserialize(oldOutput.toBinary())
  assert.equal(importedCommand.compatibility?.legacyUnknownFields?.length, 1)
  assert.equal(importedResult.compatibility?.legacyUnknownFields?.length, 1)

  const rewrittenCommand = commandStorage.serialize(importedCommand)
  const rewrittenResult = resultStorage.serialize(importedResult)
  assert.ok(new TextDecoder().decode(rewrittenCommand).startsWith("SLATE-AGENT-SHELL-INVOCATION\n"))
  assert.ok(new TextDecoder().decode(rewrittenResult).startsWith("SLATE-AGENT-SHELL-RESULT\n"))

  const command = shellInvocationToRunner(commandStorage.deserialize(rewrittenCommand))
  const result = shellResultToRunner(resultStorage.deserialize(rewrittenResult))
  assert.equal(command.command, "echo retained")
  assert.equal(ShellCommand.runtime.bin.listUnknownFields(command).length, 1)
  assert.equal(result.stdout, "out")
  assert.equal(result.stderr, "err")
  assert.equal(result.exitCode, -2)
  assert.equal(ShellOutput.runtime.bin.listUnknownFields(result).length, 1)
})

test("malformed versioned shell data is rejected instead of falling through to legacy parsing", () => {
  assert.throws(
    () => invocationSerde().deserialize(new TextEncoder().encode("SLATE-AGENT-SHELL-INVOCATION\n{")),
    /not valid JSON/,
  )
  assert.throws(
    () => resultSerde().deserialize(new TextEncoder().encode("SLATE-AGENT-SHELL-RESULT\n{}")),
    /envelope is invalid/,
  )
  assert.throws(
    () => createSlateShellResult({ standardOutput: "", standardError: "", exitCode: 2_147_483_648 }),
    /signed 32-bit integer/,
  )
})
