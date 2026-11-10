export {
  createProductionHostMainDependencies,
  installShutdownHandlers,
  main as runWorkHostMain,
  startProductionHost,
} from "./host/main.ts"
export type {
  GatewayServerConfig,
  HostMainDependencies,
  HostMainHost,
  HostProductionPorts,
  HostProcessControl,
  HostLock,
  HostLockResult,
  StartedGateway,
} from "./host/main.ts"
export { createProductionHostPorts } from "./host/production-composition.ts"
export { createProductionSlateHost } from "./host/slate-host-production.ts"
export type { ProductionSlateHostPorts, ProductionExtensionHostAdapters } from "./host/slate-host-production.ts"
export { SlateHost } from "./host/slate-host.ts"
export type {
  DynamicHostApi,
  HostExtensionRegistry,
  HostLifecycleProgress,
  HostRunnerComposition,
  SlateHostHealth,
  SlateHostRuntime,
} from "./host/slate-host.ts"
