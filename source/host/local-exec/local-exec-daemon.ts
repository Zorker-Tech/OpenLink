import { join } from "node:path";
import { errorLogTag } from "../../shared/errors/summary.ts";
import { getSlateVariant } from "../../shared/node/slate-variant.ts";
import { SlateSettingsStore } from "../../shared/node/settings/slate-settings-store.ts";
import { getSlateRootDir } from "../host-paths.ts";
import {
  clearLocalExecDaemonDiscoveryIfMatches,
  getLocalExecDaemonConnectionPath,
  getLocalExecDaemonCredentialPath,
  getLocalExecDaemonDiscoveryPath,
  getLocalExecSupervisorHeartbeatPath,
  readLocalExecDaemonConnection,
  readLocalExecDaemonCredential,
  writeLocalExecDaemonConnection,
} from "./local-exec-daemon-protocol.ts";
import { SlateLocalExecProvider } from "./local-exec-provider.ts";
import { getLocalToolApprovalsPath, getLocalToolRetirementsPath } from "./local-tool-approvals.ts";
import { resolveLocalExecConnectionFromBackend } from "./local-exec-daemon-connection.ts";
import { createLocalExecDaemonDiscoveryPublisher } from "./local-exec-daemon-discovery-publisher.ts";
import { createLocalExecPermissionBlocker, isLocalExecDaemonSupervised, retireDaemonApproval } from "./local-exec-daemon-policy.ts";
import { LOCAL_EXEC_CONNECTION_PATH, NO_LOCAL_EXEC_CONNECTION_MESSAGE, SlateLocalExecConnectionError, type RunLocalExecDaemonOptions } from "./local-exec-daemon-run-contracts.ts";
import type { LocalExecConnection } from "./local-exec-daemon-protocol.ts";
import type { SlateLocalExecProviderOptions } from "./local-exec-provider.ts";

/** Start the provider and own the durable connection, permission, and discovery callbacks it uses. */
export async function runLocalExecDaemon(options: RunLocalExecDaemonOptions = {}): Promise<{ close(): Promise<void> }> {
  const connectionPath = options.connectionPath ?? getLocalExecDaemonConnectionPath();
  const credentialPath = options.credentialPath ?? getLocalExecDaemonCredentialPath();
  const heartbeatPath = options.supervisorHeartbeatPath ?? getLocalExecSupervisorHeartbeatPath();
  const discoveryPath = options.discoveryPath ?? getLocalExecDaemonDiscoveryPath();
  const shouldPublishDiscovery = options.publishDiscovery !== false;
  const resolveBackendConnection = options.resolveConnectionFromBackend ?? resolveLocalExecConnectionFromBackend;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const startedAt = now();
  const { entryRealpath, generationToken } = options;

  const identity = entryRealpath == null || generationToken == null
    ? null
    : { pid, startedAt, entryRealpath, generationToken };
  if (shouldPublishDiscovery && identity === null) {
    throw new SlateLocalExecConnectionError("local-exec daemon discovery requires canonical entry identity and generation token");
  }

  const settings = options.settingsStore ?? new SlateSettingsStore(join(getSlateRootDir(), "settings.json"));
  const approvalsPath = options.approvalsPath ?? getLocalToolApprovalsPath();
  const retirementsPath = options.retirementsPath ?? getLocalToolRetirementsPath();
  const executor = options.executor;
  if (executor === undefined) throw new SlateLocalExecConnectionError("local-exec executor runtime is not configured");

  const discovery = shouldPublishDiscovery && identity !== null
    ? createLocalExecDaemonDiscoveryPublisher(identity, discoveryPath)
    : null;
  const connectionFromFile = async (): Promise<LocalExecConnection> => {
    const connection = await readLocalExecDaemonConnection(connectionPath);
    if (connection === null) throw new SlateLocalExecConnectionError(NO_LOCAL_EXEC_CONNECTION_MESSAGE);
    return connection;
  };

  const providerOptions: SlateLocalExecProviderOptions = {
    executor,
    resolveConnection: connectionFromFile,
    onConnectionStale: async () => {
      const handoff = await readLocalExecDaemonCredential(credentialPath);
      if (handoff === null) return;
      const fresh = await resolveBackendConnection({ backendUrl: handoff.backendUrl, credential: handoff.credential });
      if (fresh !== null) await writeLocalExecDaemonConnection(fresh, connectionPath);
    },
    isLocalUseBlocked: createLocalExecPermissionBlocker({ settings, approvalsPath, retirementsPath }),
    onApprovalRetired: (approvalId) => retireDaemonApproval(approvalId, approvalsPath, retirementsPath),
    ...(discovery === null ? {} : { onInflightChange: (count: number) => discovery.updateInflightCount(count) }),
    isSupervised: () => isLocalExecDaemonSupervised(heartbeatPath, now),
    variant: getSlateVariant(),
  };

  const provider = options.providerFactory?.(providerOptions) ?? new SlateLocalExecProvider(providerOptions);
  provider.start();
  if (discovery !== null) await discovery.publish();

  return {
    close: async () => {
      provider.close();
      if (discovery !== null && identity !== null) {
        await clearLocalExecDaemonDiscoveryIfMatches(identity, discoveryPath).catch((error) => {
          console.error(`[local-exec-daemon] failed to clear discovery record on close: ${errorLogTag(error)}`);
        });
      }
    },
  };
}

export {
  LOCAL_EXEC_CONNECTION_PATH,
  NO_LOCAL_EXEC_CONNECTION_MESSAGE,
  SlateLocalExecConnectionError,
} from "./local-exec-daemon-run-contracts.ts";
export { resolveLocalExecConnectionFromBackend } from "./local-exec-daemon-connection.ts";
export type { RunLocalExecDaemonOptions } from "./local-exec-daemon-run-contracts.ts";
