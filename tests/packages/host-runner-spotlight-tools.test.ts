import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ToolSetHandle } from "../../source/packages/agent/tools/tool-execution.ts"
import type { DynamicToolRegistry } from "../../source/packages/agent/tools/mcp/builtin-tools.ts"
import { spotlightOpen, spotlightClose } from "../../source/shared/slate-spotlight.ts"
import { fencedToolSet, withSpotlightedToolResult, type SlateTool } from "../../source/host/runner/tools/slate-spotlight-tools.ts"

describe("runner spotlight tool wrapping", () => {
  it("leaves a tool without a renderer untouched", () => {
    const tool = { name: "NoRenderer", toolIdentifier: "CUSTOM" } satisfies SlateTool
    assert.equal(withSpotlightedToolResult(tool), tool)
  })

  it("wraps array content, preserves other reply fields and forwards render arguments", async () => {
    const calls: unknown[][] = []
    const tool = {
      name: "Lookup",
      toolIdentifier: "CUSTOM",
      render: async (...args: readonly unknown[]) => {
        calls.push([...args])
        return {
          content: [{ type: "text", text: "outside text" }, { type: "image", url: "local-image" }],
          metadata: "kept",
        }
      },
    } satisfies SlateTool

    const wrapped = withSpotlightedToolResult(tool)
    const reply = await wrapped.render?.("topic", { depth: 2 })

    assert.notEqual(wrapped, tool)
    assert.deepEqual(calls, [["topic", { depth: 2 }]])
    assert.equal(reply?.metadata, "kept")
    assert.deepEqual(reply?.content, [
      { type: "text", text: spotlightOpen("Lookup") },
      { type: "text", text: "outside text" },
      { type: "image", url: "local-image" },
      { type: "text", text: spotlightClose() },
    ])
  })

  it("passes through non-array content and does not wrap tools while disabled", async () => {
    const tool = {
      name: "Plain",
      toolIdentifier: "CUSTOM",
      render: async () => ({ content: "already rendered", status: 204 }),
    } satisfies SlateTool
    const direct = withSpotlightedToolResult(tool)
    const disabled = fencedToolSet([tool], false)

    assert.deepEqual(await direct.render?.(), { content: "already rendered", status: 204 })
    assert.equal(disabled.getAllTools()[0], tool)
  })

  it("wraps before partitioning, so dynamic registry tools carry the same fence", async () => {
    let published: Parameters<DynamicToolRegistry["replaceTools"]>[0] | undefined
    const registry: Pick<DynamicToolRegistry, "replaceTools"> = {
      replaceTools: (tools) => { published = tools },
    }
    const discovery = { name: "Discover", dynamicToolMetaRole: "discovery" } satisfies SlateTool
    const invocation = { name: "Invoke", dynamicToolMetaRole: "invocation" } satisfies SlateTool
    const dynamic = {
      name: "RemoteLookup",
      toolIdentifier: "CUSTOM",
      render: async () => ({ content: [{ type: "text", text: "remote result" }] }),
    } satisfies SlateTool

    const handle: ToolSetHandle = fencedToolSet([discovery, invocation, dynamic], true, registry)
    const dynamicTool = handle.getDynamicTools()[0] as SlateTool
    const rendered = await dynamicTool.render?.()

    assert.equal(handle.getDynamicTools()[0]?.name, "RemoteLookup")
    assert.equal(published?.dynamicTools[0]?.name, "RemoteLookup")
    assert.notEqual(published?.dynamicTools[0], dynamic)
    assert.deepEqual((rendered?.content as unknown[])[0], { type: "text", text: spotlightOpen("RemoteLookup") })
  })
})
