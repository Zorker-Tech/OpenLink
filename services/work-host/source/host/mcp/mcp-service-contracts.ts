/** Stable shapes the host MCP service uses between its manager and callers. */

export interface McpServerSummary {
  id: string
  name: string
  serverIdentifier: string
  accountKey: string
  pluginId?: string | undefined
  isTeamServer: boolean
  status: string
  statusDetail?: string | undefined
  transport: string
  toolCount: number
  disabledToolCount?: number | undefined
  customInstructions: string
}

export interface CatalogField {
  key: string
  label: string
  hint: string
  isRequired?: boolean
  isSecret?: boolean
}

export interface CatalogPlugin {
  id: string
  name: string
  displayName?: string
  description?: string
  category?: string
  fields?: CatalogField[]
  connectors?: unknown[]
  skills?: Array<{ name: string; description?: string; sourceUrl?: string }>
}

export interface EffectivePlugin {
  pluginId: string
  installMode?: string
  isEnabled: boolean
  hasTeamConfiguredVariables?: boolean
}

export interface ServerState {
  servers: McpServerSummary[]
}
