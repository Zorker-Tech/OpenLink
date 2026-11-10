import type { HostSettingsPort } from "./host-settings-field-contracts.ts"

/** Read one host snapshot when the port can answer; transport failures are treated as no snapshot. */
export async function readHostSettingsSnapshot<Settings extends object>(port: HostSettingsPort<Settings>): Promise<Settings | null> {
  if (!port.isReadable()) return null
  try {
    return await port.read()
  } catch {
    return null
  }
}
