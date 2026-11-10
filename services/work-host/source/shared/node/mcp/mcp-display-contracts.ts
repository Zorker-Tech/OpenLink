export type SlateMcpServerConfig =
  | { url: string; type?: "sse" | "http"; headers?: Readonly<Record<string, string>> }
  | { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }

export interface SlateMcpDisplayRow {
  id: string
  name: string
  serverIdentifier?: string
  config: SlateMcpServerConfig
  isTeamServer: boolean
  disabledByTeamAdminPolicy?: boolean
  pluginId?: string
  isRequired?: boolean
  managedByTeamPluginPolicy?: boolean
  accounts?: readonly { accountKey: string; hasToken: boolean; serverIdentifier?: string }[]
}

export interface SlateMcpAccountDisplay {
  servers: SlateMcpDisplayRow[]
  cacheScope?: string
  unavailable?: boolean
  unresolvedServerIds?: string[]
}
