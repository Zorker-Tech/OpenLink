import type { HostExtensionContext } from "../../extensions/host-extensions.ts"
import { createDebouncePolicy, createPollingPolicy, createRetryPolicy, realClock } from "../../extensions/scheduling.ts"
import { HostExtensions } from "../../extensions/extension-ids.generated.ts"
import type { AgentStoreClientDependencies } from "./agent-store-slate-files.ts"
import {
  pinBoxStoreDiagnosticsReporter,
  type BoxStoreDiagnosticReporter,
} from "./box-store-diagnostics.ts"
import { createBoxStoreSyncService } from "./box-store-sync-service.ts"
import type { BoxStoreSyncServiceDependencies, BoxStoreTelemetry } from "./box-store-sync-service-contracts.ts"
import { createBoxStoreSyncExtensionPolicies } from "./box-store-sync-extension-policies.ts"

export interface BoxStoreHost {
  isIdle(): boolean
  log(message: string): void
}

interface BoxStoreSourceMap {
  getOrCreateBoxStore(): Promise<{ sourceId: string }>
}

interface BoxStoreLogs extends BoxStoreTelemetry {
  reportHostExtensionDiagnostic(diagnostic: Record<string, unknown>): void
}

export interface BoxStoreSyncServicePort {
  readonly api: unknown
  start(): void
  dispose(): Promise<void>
}

export interface BoxStoreSyncExtensionOverrides {
  readonly createService?: (dependencies: BoxStoreSyncServiceDependencies) => BoxStoreSyncServicePort
  readonly pinDiagnosticsReporter?: (reporter: BoxStoreDiagnosticReporter) => void
}

export function startBoxStoreSyncExtension(
  context: HostExtensionContext<BoxStoreHost>,
  overrides: BoxStoreSyncExtensionOverrides = {},
): unknown {
  const auth = context.deps[HostExtensions.Auth] as AgentStoreClientDependencies
  const sourceMap = context.deps[HostExtensions.SourceMap] as BoxStoreSourceMap
  const logs = (context.deps[HostExtensions.Telemetry] as { readonly logs: BoxStoreLogs }).logs
  const pinDiagnostics = overrides.pinDiagnosticsReporter ?? pinBoxStoreDiagnosticsReporter
  const createService = overrides.createService ?? createBoxStoreSyncService

  pinDiagnostics(diagnostic => logs.reportHostExtensionDiagnostic(diagnostic))
  const service = createService({
    auth,
    sourceMap,
    telemetry: logs,
    isIdle: context.host.isIdle,
    ...createBoxStoreSyncExtensionPolicies(),
    log: context.host.log,
  })
  context.onStop(() => service.dispose())
  service.start()
  return service.api
}
