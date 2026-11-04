import assert from "node:assert/strict"
import { test } from "node:test"

import {
  normalizeAccountLabel,
  parseMarketplacePluginIdentifier,
  projectAccountRuntimeConfig,
  projectPluginAttribution,
} from "../../source/shared/node/mcp/mcp-account-display-policy.ts"
import { projectBackendServerStatus, projectBoxServerStatus } from "../../source/shared/node/mcp/mcp-server-status-projection.ts"
import type { SlateMcpDisplayRow } from "../../source/shared/node/mcp/mcp-display-contracts.ts"

function row(overrides: Partial<SlateMcpDisplayRow> = {}): SlateMcpDisplayRow {
  return {
    id: "row-1",
    name: "Documents",
    serverIdentifier: "documents",
    config: { url: "https://mcp.example.test" },
    isTeamServer: false,
    ...overrides,
  }
}

test("account labels normalize and empty labels are refused", () => {
  assert.equal(normalizeAccountLabel("  Work   account  "), "work   account")
  assert.throws(() => normalizeAccountLabel("  "), /account label is required/)
})

test("account runtime configuration includes only enabled rows with identifiers", () => {
  const unidentified = row({ id: "unidentified" })
  delete unidentified.serverIdentifier
  assert.deepEqual(projectAccountRuntimeConfig({ servers: [
    row(),
    row({ id: "disabled", serverIdentifier: "hidden", disabledByTeamAdminPolicy: true }),
    unidentified,
    row({ id: "replacement", config: { url: "https://other.example.test", type: "http" } }),
  ] }), {
    mcpServers: {
      documents: { url: "https://other.example.test", type: "http" },
    },
  })
  assert.equal(projectAccountRuntimeConfig(null), null)
})

test("marketplace identifiers trim whitespace but retain decimal spelling", () => {
  assert.equal(parseMarketplacePluginIdentifier(" 00042 "), "00042")
  for (const invalid of ["", "plugin-1", "1.0", "1 2", "+3"]) {
    assert.throws(() => parseMarketplacePluginIdentifier(invalid), /Invalid marketplace plugin id/)
  }
})

test("plugin attribution omits false and absent policy fields", () => {
  assert.deepEqual(projectPluginAttribution(row()), {})
  assert.deepEqual(projectPluginAttribution(row({
    pluginId: "team-tool",
    isRequired: true,
    managedByTeamPluginPolicy: true,
  })), {
    pluginId: "team-tool",
    isRequired: true,
    managedByTeamPluginPolicy: true,
  })
})

test("backend and box status projections preserve their distinct fallback context", () => {
  assert.deepEqual(projectBackendServerStatus("needsAuth"), { status: "needsAuth", statusDetail: "Authentication required" })
  assert.deepEqual(projectBackendServerStatus("loading"), { status: "initializing" })
  assert.deepEqual(projectBackendServerStatus(undefined), { status: "error", statusDetail: "Not reported by backend" })
  assert.deepEqual(projectBoxServerStatus("error", false, "daemon denied the call"), { status: "error", statusDetail: "daemon denied the call" })
  assert.deepEqual(projectBoxServerStatus(undefined, true), { status: "error", statusDetail: "Slate's computer unreachable" })
  assert.deepEqual(projectBoxServerStatus(undefined, false), { status: "error", statusDetail: "Not reported by Slate's computer" })
})
