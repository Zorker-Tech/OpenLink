import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BROWSER_MCP_PROVIDER_IDS } from "../../source/packages/agent-exec/mcp-operations.ts"
import { getBrowserMcpProviderName, getBrowserToolNames } from "../../source/packages/agent/browser-tools.ts"

describe("browser MCP tool projection", () => {
  it("keeps only recognized browser providers and preserves their order", () => {
    const [browserProvider] = [...BROWSER_MCP_PROVIDER_IDS]
    assert.ok(browserProvider)
    const tools = [
      { providerIdentifier: "ordinary-mcp", name: "ordinary-tool" },
      { providerIdentifier: browserProvider, name: "first-browser_click" },
      { providerIdentifier: browserProvider, name: "second-browser_open" },
    ]

    assert.deepEqual(getBrowserToolNames(tools), ["first-browser_click", "second-browser_open"])
  })

  it("uses the first valid provider prefix and skips malformed or unmarked names", () => {
    assert.equal(getBrowserMcpProviderName(undefined), undefined)
    assert.equal(getBrowserMcpProviderName([]), undefined)
    assert.equal(getBrowserMcpProviderName(["ordinary-tool", "browser_click"]), undefined)
    assert.equal(getBrowserMcpProviderName(["-browser_malformed", "webkit-browser_open", "chromium-browser_click"]), "webkit")
    assert.equal(getBrowserMcpProviderName(["chromium-browser_click", "webkit-browser_open"]), "chromium")
  })
})
