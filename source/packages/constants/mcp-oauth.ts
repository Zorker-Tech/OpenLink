/**
 * What the platform knows about MCP OAuth providers before it asks anyone.
 *
 * Some providers cannot be discovered: they need a statically registered client, they reject custom
 * URL schemes, or they require particular authorization parameters. Where that is true the platform
 * carries the policy here, so a connector's sign-in flow starts from facts instead of from a probe
 * that would fail after the user has already been sent to a browser.
 */

export interface McpOAuthProviderPolicy {
  readonly provider: "google-workspace"
  readonly clientRegistration: "static"
  readonly unauthenticatedConnect: boolean
  readonly rejectsCustomSchemeRedirects: boolean
  readonly authorizationParams: { readonly access_type: "offline"; readonly prompt: "consent" }
  readonly scopes: readonly string[]
}

const GOOGLE_WORKSPACE_POLICY_BASE = {
  provider: "google-workspace",
  clientRegistration: "static",
  unauthenticatedConnect: true,
  rejectsCustomSchemeRedirects: true,
  authorizationParams: { access_type: "offline", prompt: "consent" },
} as const

const googleWorkspacePolicy = (scopes: readonly string[]): McpOAuthProviderPolicy => ({
  ...GOOGLE_WORKSPACE_POLICY_BASE,
  scopes,
})

export const MCP_OAUTH_PROVIDER_POLICIES = new Map<string, McpOAuthProviderPolicy>([
  ["gmailmcp.googleapis.com", googleWorkspacePolicy([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
  ])],
  ["drivemcp.googleapis.com", googleWorkspacePolicy([
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ])],
  ["calendarmcp.googleapis.com", googleWorkspacePolicy([
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ])],
  ["docsmcp.googleapis.com", googleWorkspacePolicy(["https://www.googleapis.com/auth/documents"])],
  ["sheetsmcp.googleapis.com", googleWorkspacePolicy(["https://www.googleapis.com/auth/spreadsheets"])],
  ["slidesmcp.googleapis.com", googleWorkspacePolicy(["https://www.googleapis.com/auth/presentations"])],
])

export const GOOGLE_WORKSPACE_MCP_HOSTS = new Set(
  [...MCP_OAUTH_PROVIDER_POLICIES]
    .filter(([, policy]) => policy.provider === "google-workspace")
    .map(([hostname]) => hostname),
)

/** The desktop client that completes a sign-in for a connector. */
export const MCP_OAUTH_EXTENSION_ID = "slate.mcp"
export const MCP_OAUTH_RETURN_PATH = "/oauth/return"
export const MCP_OAUTH_DESKTOP_RETURN_URL = `slate://${MCP_OAUTH_EXTENSION_ID}${MCP_OAUTH_RETURN_PATH}`
export const MCP_OAUTH_LOOPBACK_CALLBACK_URL = "http://localhost:8787/callback"
