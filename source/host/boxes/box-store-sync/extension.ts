/**
 * The box store as a host extension.
 *
 * The extension does three things and nothing else: it gives the store the diagnostics sink, it builds the store with the
 * host's own policies (polling, debounce, retry, clock — all resolved here so the store never reads the environment), and
 * it hands back the API the rest of the platform asks for. Stopping the host disposes the store through the extension's
 * own stop hook, so the poll and the watcher stop with it.
 */
import { defineHostExtension } from "../../extensions/host-extensions.ts"
import { HostExtensions } from "../../extensions/extension-ids.generated.ts"
import { startBoxStoreSyncExtension, type BoxStoreHost } from "./box-store-sync-extension-composition.ts"

export const boxStoreSyncExtension = defineHostExtension<unknown, BoxStoreHost>({
  id: HostExtensions.BoxStoreSync,
  dependencies: [HostExtensions.Auth, HostExtensions.Mcp, HostExtensions.SourceMap, HostExtensions.Telemetry],
  start: context => startBoxStoreSyncExtension(context),
});
