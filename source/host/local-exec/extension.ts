import { defineHostExtension } from "../extensions/host-extensions.ts"
import { HostExtensions } from "../extensions/extension-ids.generated.ts"
import type { GatewayLocalExecCodec } from "./gateway-local-exec-slate-box.ts"
import { createLocalExecExtensionApi } from "./local-exec-extension-api.ts"
import type { LocalExecExtensionHost } from "./local-exec-extension-contracts.ts"
import { startLocalExecBridge } from "./local-exec-extension-lifecycle.ts"

export function createLocalExecExtension<Client = unknown, Accessor = unknown>(
  codec: GatewayLocalExecCodec<Client, Accessor>,
) {
  return defineHostExtension<unknown, LocalExecExtensionHost>({
    id: HostExtensions.LocalExec,
    dependencies: [HostExtensions.LocalToolPermission, HostExtensions.Telemetry],
    start(context) {
      const bridge = startLocalExecBridge(context, codec)
      return createLocalExecExtensionApi(bridge.bridge, bridge.options)
    },
  })
}
