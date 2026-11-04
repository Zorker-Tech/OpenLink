import { proxifyBoxVncUrl } from "./box-vnc-url-projection.ts"
import type { ForeverBoxStatus, VncProxyDescriptor } from "./box-vnc-proxy-contracts.ts"

export function proxifyForeverBoxStatus<Status extends ForeverBoxStatus>(
  status: Status,
  proxy: VncProxyDescriptor | null,
): Status {
  if (proxy === null) return status

  const proxifiedStatus = {
    ...status,
    vncUrl: status.vncUrl == null ? status.vncUrl : proxifyBoxVncUrl(status.vncUrl, proxy),
  }
  if (status.windows == null) return proxifiedStatus as Status

  return {
    ...proxifiedStatus,
    windows: status.windows.map(window => ({
      ...window,
      vncUrl: proxifyBoxVncUrl(window.vncUrl, proxy),
    })),
  } as Status
}
