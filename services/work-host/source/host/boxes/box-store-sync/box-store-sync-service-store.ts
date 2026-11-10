/** Store identity, read-only access and the operations exposed through the host API. */
import { AgentStoreObjectStoreProvider, type BoxObjectStoreProvider } from "./box-object-store.ts";
import { BoxStoreSync } from "./box-store-sync.ts";
import type { BoxStoreCategory } from "./box-store-sync-contracts.ts";
import { isAgentStoreSourceId } from "../../../packages/agent-store-sync/identifiers.ts";
import { evaluateBoxStoreFlush } from "./box-store-sync.ts";
import { CHROME_SESSION_CATEGORY_NAME } from "./chrome-session-stage.ts";
import type { BoxStoreSyncServiceDependencies } from "./box-store-sync-service-contracts.ts";
import type { BoxStoreBackendPolicy } from "../box-store-backend-policy.ts";

type SyncBuilder = (categories: readonly BoxStoreCategory[], provider: BoxObjectStoreProvider, logPrefix: string) => BoxStoreSync;

export class BoxStoreSyncServiceStore {
  private accessorInstance: BoxStoreSync | undefined;

  constructor(
    private readonly dependencies: BoxStoreSyncServiceDependencies,
    private readonly env: NodeJS.ProcessEnv,
    private readonly backendPolicy: BoxStoreBackendPolicy,
    private readonly objectStoreProvider: BoxObjectStoreProvider,
    private readonly sync: BoxStoreSync | undefined,
    private readonly createSync: SyncBuilder,
  ) {}

  async getStoreId(): Promise<string> {
    const override = this.env.SLATE_BOX_STORE_ID?.trim();
    if (override !== undefined && override.length > 0 && isAgentStoreSourceId(override)) return override;
    return (await this.dependencies.sourceMap.getOrCreateBoxStore()).sourceId;
  }

  async snapshotNow(args: { includeIdleOnly?: boolean }): Promise<ReturnType<typeof evaluateBoxStoreFlush>> {
    if (this.sync === undefined) {
      return {
        ok: false,
        manifestEntries: 0,
        storeDbEntries: 0,
        agentDirEntries: 0,
        storeDbComplete: false,
        filesUploaded: 0,
        reason: "store-sync-disabled",
      };
    }

    const summary = await this.sync.snapshotNow({
      includeIdleOnly: args.includeIdleOnly === true,
      includeStoreDbs: true,
      waitForInFlight: true,
      acceptMatchingCanonicalOnConflict: true,
    }).catch(error => {
      this.dependencies.log(`flush snapshot rejected: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    return evaluateBoxStoreFlush(summary, { sessionCategoryName: CHROME_SESSION_CATEGORY_NAME });
  }

  readStatus(): ReturnType<BoxStoreSync["readStoreStatus"]> {
    return this.accessor().readStoreStatus();
  }

  async clearStore(): Promise<{ ok: boolean; reason?: string }> {
    if (this.backendPolicy.kind === "slate-box-store-v2") {
      const legacyStore = this.createSync([], new AgentStoreObjectStoreProvider(this.dependencies.auth), "[box-store-clear-legacy]");
      const result = await legacyStore.clearStore();
      await legacyStore.dispose();
      if (!result.ok) return { ok: false, reason: `legacy store clear failed: ${result.reason ?? "unknown"}` };
    }
    return this.accessor().clearStore();
  }

  scheduleStoreDbSnapshot(agentId: string): void {
    this.sync?.scheduleStoreDbSnapshot(agentId);
  }

  async forgetAgent(agentId: string): Promise<void> {
    await (this.sync ?? this.accessor()).forgetAgent(agentId);
  }

  async disposeAccessor(): Promise<void> {
    if (this.accessorInstance !== undefined && this.accessorInstance !== this.sync) {
      await this.accessorInstance.dispose();
    }
    this.accessorInstance = undefined;
  }

  private accessor(): BoxStoreSync {
    if (this.sync !== undefined) return this.sync;
    this.accessorInstance ??= this.createSync([], this.objectStoreProvider, "[box-store-access]");
    return this.accessorInstance;
  }
}
