/** Creates the stable extension surface over the box-store service internals. */
import type { BoxObjectStoreProvider } from "./box-object-store.ts";
import type { BoxStoreSyncApi } from "./box-store-sync-service-contracts.ts";
import { BoxStoreSyncServiceStore } from "./box-store-sync-service-store.ts";

export function createBoxStoreSyncApi(args: {
  enabled: boolean;
  provider: BoxObjectStoreProvider;
  store: BoxStoreSyncServiceStore;
}): BoxStoreSyncApi {
  const { store } = args;
  return {
    isEnabled: args.enabled,
    objectStoreProvider: args.provider,
    getStoreId: () => store.getStoreId(),
    snapshotBoxStoreNow: input => store.snapshotNow(input),
    getBoxStoreStatus: () => store.readStatus(),
    clearBoxStoreNow: () => store.clearStore(),
    scheduleStoreDbSnapshot: agentId => store.scheduleStoreDbSnapshot(agentId),
    forgetAgent: agentId => store.forgetAgent(agentId),
  };
}
