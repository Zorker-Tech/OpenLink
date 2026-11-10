export interface HostSettingsPort<Settings extends object> {
  isReadable(): boolean
  read(): Promise<Settings>
  write(update: Partial<Settings>): Promise<Settings | null>
}

export interface HostSettingsMirror<Value> {
  read(): Value | undefined
  write(value: Value): void
  clear?: () => void
}

export type HostSettingsFieldUpdate<Value> =
  | { readonly status: "unreachable" }
  | { readonly status: "persisted"; readonly value: Value | null }
