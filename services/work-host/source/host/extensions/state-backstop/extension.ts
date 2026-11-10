import { createDebouncePolicy, realClock } from "../scheduling.ts"
import { defineHostExtension } from "../host-extensions.ts"
import { HostExtensions } from "../extension-ids.generated.ts"
import type { HostExtensionContext } from "../host-extensions.ts"
import { STATE_BACKSTOP_DEBOUNCE_MS, SlateStateBackstop, isStateBackstopEnabled, type StateBackstopDeps } from "./state-backstop-service.ts"

type LocalStateAccess = Pick<StateBackstopDeps, "agentsRootDir" | "readDbBytes">
type BackstopHostPort = { readonly log: (message: string) => void }

function disabledBackstopSurface() {
  return {
    isEnabled: false,
    scheduleSnapshot: (_agentId: string): void => {},
    snapshotNow: async (_agentId: string) => ({ status: "skipped" as const, reason: "backstop disabled" }),
    readSnapshot: async (_agentId: string): Promise<Uint8Array | null> => null,
  }
}

function activeBackstopSurface(backstop: SlateStateBackstop) {
  return {
    isEnabled: true,
    scheduleSnapshot: (agentId: string) => backstop.scheduleSnapshot(agentId),
    snapshotNow: (agentId: string) => backstop.snapshotNow(agentId),
    readSnapshot: (agentId: string) => backstop.readSnapshot(agentId),
  }
}

function resolveBoxServices(context: HostExtensionContext<BackstopHostPort>): Pick<StateBackstopDeps, "objectStoreProvider" | "sourceMap"> {
  return {
    objectStoreProvider: (context.deps[HostExtensions.BoxStoreSync] as { readonly objectStoreProvider: StateBackstopDeps["objectStoreProvider"] }).objectStoreProvider,
    sourceMap: context.deps[HostExtensions.SourceMap] as StateBackstopDeps["sourceMap"],
  }
}

function createRunningBackstop(
  context: HostExtensionContext<BackstopHostPort>,
  localState: LocalStateAccess,
): SlateStateBackstop {
  return new SlateStateBackstop({
    ...resolveBoxServices(context),
    debounce: createDebouncePolicy(realClock, {
      name: "slate-state-backstop-snapshot",
      delayMs: STATE_BACKSTOP_DEBOUNCE_MS,
    }),
    ...localState,
  })
}

export function createStateBackstopExtension(
  localState: LocalStateAccess,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return defineHostExtension<unknown, BackstopHostPort>({
    id: HostExtensions.StateBackstop,
    dependencies: [HostExtensions.BoxStoreSync, HostExtensions.SourceMap],
    start(extensionContext) {
      if (!isStateBackstopEnabled(environment)) return disabledBackstopSurface()

      const backstop = createRunningBackstop(extensionContext, localState)
      extensionContext.onStop(() => backstop.dispose())
      extensionContext.host.log("SlateState S3 backstop enabled")
      return activeBackstopSurface(backstop)
    },
  })
}
