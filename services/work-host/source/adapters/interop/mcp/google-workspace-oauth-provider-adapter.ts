/** Provider registration requirements and scopes kept at the external MCP OAuth boundary. */

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

export const MCP_OAUTH_PROVIDER_POLICIES: ReadonlyMap<string, McpOAuthProviderPolicy> = new Map([
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

export const GOOGLE_WORKSPACE_MCP_HOSTS: ReadonlySet<string> = new Set(MCP_OAUTH_PROVIDER_POLICIES.keys())
