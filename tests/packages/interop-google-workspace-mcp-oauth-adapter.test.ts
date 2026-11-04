import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  GOOGLE_WORKSPACE_MCP_HOSTS,
  MCP_OAUTH_PROVIDER_POLICIES,
} from "../../source/adapters/interop/mcp/google-workspace-oauth-provider-adapter.ts"

describe("Google Workspace MCP OAuth interop policy", () => {
  it("keeps the supported provider hosts and their exact authorization scopes together", () => {
    const expectedScopes = new Map<string, readonly string[]>([
      ["gmailmcp.googleapis.com", [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
      ]],
      ["drivemcp.googleapis.com", [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ]],
      ["calendarmcp.googleapis.com", [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
      ]],
      ["docsmcp.googleapis.com", ["https://www.googleapis.com/auth/documents"]],
      ["sheetsmcp.googleapis.com", ["https://www.googleapis.com/auth/spreadsheets"]],
      ["slidesmcp.googleapis.com", ["https://www.googleapis.com/auth/presentations"]],
    ])

    assert.deepEqual([...MCP_OAUTH_PROVIDER_POLICIES.keys()], [...expectedScopes.keys()])
    assert.deepEqual([...GOOGLE_WORKSPACE_MCP_HOSTS], [...expectedScopes.keys()])
    for (const [host, scopes] of expectedScopes) {
      const policy = MCP_OAUTH_PROVIDER_POLICIES.get(host)
      assert.ok(policy, host)
      assert.equal(policy.provider, "google-workspace")
      assert.equal(policy.clientRegistration, "static")
      assert.equal(policy.unauthenticatedConnect, true)
      assert.equal(policy.rejectsCustomSchemeRedirects, true)
      assert.deepEqual(policy.authorizationParams, { access_type: "offline", prompt: "consent" })
      assert.deepEqual(policy.scopes, scopes)
    }
    assert.equal(MCP_OAUTH_PROVIDER_POLICIES.has("unknown.example"), false)
  })
})
