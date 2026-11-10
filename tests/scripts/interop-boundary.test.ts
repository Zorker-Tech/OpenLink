import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  compareConsumerAllowlist,
  coreInteropConsumers,
  declaresPluginMcpInteropSchema,
  importedInteropModules,
  importsCounterpartExecutionWire,
  importsExternalProtobufRuntime,
} from "../../scripts/check-interop-boundary.mjs"

describe("external wire-schema boundary ledger", () => {
  it("records every static core import of an interop adapter", () => {
    assert.deepEqual(
      importedInteropModules(`
        import { one } from "../adapters/interop/agent/one.ts"
        export { two } from "../adapters/interop/agent/two.ts"
        const lazy = import("../adapters/interop/agent/three.ts")
        import "../adapters/interop/agent/side-effect.ts"
      `),
      [
        "../adapters/interop/agent/one.ts",
        "../adapters/interop/agent/side-effect.ts",
        "../adapters/interop/agent/three.ts",
        "../adapters/interop/agent/two.ts",
      ],
    )
    assert.deepEqual(
      coreInteropConsumers([
        { relative: "source/z.ts", contents: 'import "adapters/interop/b.ts"' },
        { relative: "source/a.ts", contents: 'import "adapters/interop/a.ts"' },
      ]),
      [
        "source/a.ts\tadapters/interop/a.ts",
        "source/z.ts\tadapters/interop/b.ts",
      ],
    )
  })

  it("finds new direct consumers and stale entries", () => {
    assert.deepEqual(
      compareConsumerAllowlist(["source/host/a.ts", "source/host/b.ts"], ["source/host/a.ts", "source/host/old.ts"]),
      {
        added: ["source/host/b.ts"],
        stale: ["source/host/old.ts"],
      },
    )
  })

  it("passes when the consumer list matches exactly", () => {
    assert.deepEqual(
      compareConsumerAllowlist(["source/host/a.ts"], ["source/host/a.ts"]),
      { added: [], stale: [] },
    )
  })

  it("keeps the external plugin MCP parser schema out of product-owned modules", () => {
    assert.equal(declaresPluginMcpInteropSchema("export const mcpConfigSchema = z.object({})"), true)
    assert.equal(declaresPluginMcpInteropSchema("export interface McpConfig { mcpServers?: Record<string, unknown> }"), false)
    assert.equal(declaresPluginMcpInteropSchema("export const externalPluginMcpConfigSchema = z.object({})"), false)
  })

  it("keeps generated execution messages out of Slate-owned local-exec wire modules", () => {
    assert.equal(importsCounterpartExecutionWire('import type { JsonValue } from "@bufbuild/protobuf"'), true)
    assert.equal(importsCounterpartExecutionWire('import { ExecServerMessage } from "../adapters/interop/proto/generated/agent/v1/exec_pb.ts"'), true)
    assert.equal(importsCounterpartExecutionWire('const typeName = "agent.v1.ExecServerMessage"'), true)
    assert.equal(importsCounterpartExecutionWire('import { jsonValueSchema } from "@slate/work-domain"'), false)
  })

  it("keeps the external protobuf runtime out of product modules", () => {
    assert.equal(importsExternalProtobufRuntime('import type { JsonValue } from "@bufbuild/protobuf"'), true)
    assert.equal(importsExternalProtobufRuntime('import type { JsonValue } from "@slate/work-domain"'), false)
  })
})
