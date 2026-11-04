import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Context } from "../../source/packages/context/context.ts"
import { SlateBoxMcpUnsupportedError } from "../../source/host/boxes/box-mcp.ts"
import { createBoxMcpPort } from "../../source/adapters/interop/agent/box-mcp-control-adapter.ts"

describe("box MCP control adapter", () => {
  it("translates the host configuration argument into the wire request and returns loaded server names", async () => {
    const context = {} as Context
    const requests: unknown[] = []
    const port = createBoxMcpPort(
      {
        loadMcpServers: async (receivedContext, request: { mcpConfigJson: string; removeMissing: true }) => {
          requests.push([receivedContext, request])
          return { loadedServerNames: ["search", "notes"] }
        },
      },
      (mcpConfigJson) => ({ mcpConfigJson, removeMissing: true as const }),
    )

    assert.deepEqual(await port.loadServers(context, '{"servers":[]}'), ["search", "notes"])
    assert.deepEqual(requests, [[context, { mcpConfigJson: '{"servers":[]}', removeMissing: true }]])
  })

  it("maps only an unimplemented service response to the Slate unsupported-capability error", async () => {
    for (const code of [12, "unimplemented", "UNIMPLEMENTED"]) {
      const cause = Object.assign(new Error("not available"), { code })
      const port = createBoxMcpPort(
        { loadMcpServers: async () => { throw cause } },
        (mcpConfigJson) => ({ mcpConfigJson }),
      )

      await assert.rejects(port.loadServers({} as Context, "{}"), (error: unknown) => {
        assert.equal(error instanceof SlateBoxMcpUnsupportedError, true)
        assert.equal((error as Error).cause, cause)
        return true
      })
    }

    const ordinaryFailure = new Error("server rejected the request")
    const ordinaryPort = createBoxMcpPort(
      { loadMcpServers: async () => { throw ordinaryFailure } },
      (mcpConfigJson) => ({ mcpConfigJson }),
    )
    await assert.rejects(ordinaryPort.loadServers({} as Context, "{}"), (error: unknown) => error === ordinaryFailure)
  })
})
