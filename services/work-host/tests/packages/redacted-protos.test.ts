import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { CodeBlock, DetailedLine } from "../../source/adapters/interop/proto/generated/aiserver/v1/utils_pb.ts"
import * as utilsRedactedModule from "../../source/adapters/interop/redacted-protos/generated/aiserver/v1/utils_redacted.ts"
import * as mcpExecRedactedModule from "../../source/adapters/interop/redacted-protos/generated/agent/v1/mcp_exec_redacted.ts"

/**
 * The generated surface is runtime-only (`@ts-nocheck`), so the shapes it is called with are stated
 * here instead of inferred from untyped code.
 */
type GeneratedRedaction = {
  readonly toRedacted: (message: unknown, mode: unknown) => any
  readonly fromRedacted: (message: unknown, purpose: string, options?: unknown) => any
}

const utilsRedacted = utilsRedactedModule as unknown as Record<string, GeneratedRedaction["toRedacted"] | GeneratedRedaction["fromRedacted"]>
const mcpExecRedacted = mcpExecRedactedModule as unknown as Record<string, GeneratedRedaction["toRedacted"] | GeneratedRedaction["fromRedacted"]>

const toRedactedDetailedLine = utilsRedacted.toRedactedDetailedLine as GeneratedRedaction["toRedacted"]
const fromRedactedDetailedLine = utilsRedacted.fromRedactedDetailedLine as GeneratedRedaction["fromRedacted"]
const toRedactedCodeBlock = utilsRedacted.toRedactedCodeBlock as GeneratedRedaction["toRedacted"]
const fromRedactedCodeBlock = utilsRedacted.fromRedactedCodeBlock as GeneratedRedaction["fromRedacted"]
const toRedactedReadMcpResourceSuccess = mcpExecRedacted.toRedactedReadMcpResourceSuccess as GeneratedRedaction["toRedacted"]
const fromRedactedReadMcpResourceSuccess = mcpExecRedacted.fromRedactedReadMcpResourceSuccess as GeneratedRedaction["fromRedacted"]

import { ReadMcpResourceSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"

const read = "unsafe_always_allowed"
const mode = PrivacyMode.NO_STORAGE

test("a redacted field arrives as a value that names itself and its classification", () => {
  const redacted = toRedactedDetailedLine(new DetailedLine({ text: "the secret", lineNumber: 7, isSignature: true }), mode)

  assert.equal(redacted._privacyMode, mode)
  assert.ok(isRedactedString(redacted.text))
  assert.equal(redacted.text.__classification, DataClassification.CODE)
  assert.equal(redacted.text.__fieldName, "text")
  assert.equal(redacted.lineNumber, 7, "an ordinary field is passed through")
  assert.equal(redacted.isSignature, true)
})

test("the placeholder a reader sees names the field, not the value", () => {
  const redacted = toRedactedCodeBlock(
    new CodeBlock({ relativeWorkspacePath: "src/app.ts", contents: "export const x = 1" }),
    { privacyMode: mode, enforceRedaction: true },
  )
  assert.equal(redacted.relativeWorkspacePath.__classification, DataClassification.PATH)
  assert.equal(String(redacted.relativeWorkspacePath), "[redacted:relative_workspace_path]")
  assert.equal(String(redacted.contents), "[redacted:contents]")
})

test("rebuilding the message asks for a purpose and returns a real proto message", () => {
  const original = new DetailedLine({ text: "the secret", lineNumber: 3, isSignature: false })
  const rebuilt = fromRedactedDetailedLine(toRedactedDetailedLine(original, mode), read)
  assert.ok(rebuilt instanceof DetailedLine)
  assert.equal(rebuilt.text, "the secret")
  assert.equal(rebuilt.lineNumber, 3)
})

test("nested messages are redacted at every level", () => {
  const original = new CodeBlock({ relativeWorkspacePath: "src/app.ts", contents: "export const x = 1" })
  const redacted = toRedactedCodeBlock(original, mode)
  assert.ok(isRedactedString(redacted.relativeWorkspacePath))
  const rebuilt = fromRedactedCodeBlock(redacted, read)
  assert.equal(rebuilt.relativeWorkspacePath, "src/app.ts")
  assert.equal(rebuilt.contents, "export const x = 1")
})

test("a message whose fields are not sensitive still travels through the redacted surface", () => {
  const original = new CodeBlock({ relativeWorkspacePath: "", contents: "" })
  const redacted = toRedactedCodeBlock(original, mode)
  const rebuilt = fromRedactedCodeBlock(redacted, read)
  assert.deepEqual(rebuilt.toJson(), original.toJson())
})

test("a map keeps its shape and redacts its values", () => {
  const original = new ReadMcpResourceSuccess({ annotations: { a: "secret-a", b: "secret-b" } })
  const redacted = toRedactedReadMcpResourceSuccess(original, mode)

  assert.equal(redacted.annotations.size, 2, "the keys survive")
  const first = redacted.annotations.get("a")
  assert.ok(isRedactedString(first))
  assert.equal(first.__fieldName, "annotations")

  const rebuilt = fromRedactedReadMcpResourceSuccess(redacted, read)
  // A map is a Map on a message built from the wire, a plain object when constructed by hand.
  const entries = (value: unknown): [string, string][] => value instanceof Map
    ? [...value.entries()]
    : Object.entries(value as Record<string, string>)
  assert.deepEqual(entries(rebuilt.annotations).sort(), [["a", "secret-a"], ["b", "secret-b"]])
})

test("an enforced surface refuses to rebuild without a purpose that allows it", () => {
  const redacted = toRedactedDetailedLine(
    new DetailedLine({ text: "private" }),
    { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true },
  )
  assert.throws(() => fromRedactedDetailedLine(redacted, "storage_for_training"), /Unwrap not allowed/)
  assert.equal(
    fromRedactedDetailedLine(redacted, "storage_for_training", { redactUnallowedFieldsInsteadOfThrowing: true }).text,
    "[redacted:text]",
  )
  assert.equal(fromRedactedDetailedLine(redacted, read).text, "private")
})

test("every annotated message has both directions generated", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "source", "adapters", "interop", "redacted-protos", "generated")
  const namespaces = await readdir(root)
  let modules = 0
  let pairs = 0
  for (const namespace of namespaces) {
    const directory = path.join(root, namespace, "v1")
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith("_redacted.ts")) continue
      modules += 1
      const module = await import(pathToFileURL(path.join(directory, entry)).href)
      const exported = Object.keys(module)
      for (const name of exported.filter(candidate => candidate.startsWith("toRedacted"))) {
        assert.ok(
          exported.includes(name.replace(/^toRedacted/, "fromRedacted")),
          `${entry} exports ${name} without its counterpart`,
        )
        pairs += 1
      }
    }
  }
  assert.equal(modules, 80, "the redacted surface covers the modules it is meant to")
  assert.ok(pairs > 600, `expected a full surface, saw ${pairs} pairs`)
})
