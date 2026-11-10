import type { LocalExecConnection } from "./local-exec-daemon-protocol.ts";
import type { LocalExecExecutor, SlateLocalExecProviderOptions } from "./local-exec-provider.ts";

export class SlateLocalExecConnectionError extends Error {}

export const NO_LOCAL_EXEC_CONNECTION_MESSAGE = "local-exec daemon has no gateway connection yet (waiting for the desktop to hand one off)";
export const LOCAL_EXEC_CONNECTION_PATH = "/slate-box/local-exec-connection";

export interface LocalExecBackendConnectionRequest {
  readonly backendUrl: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}

export type LocalExecBackendConnectionResolver = (request: LocalExecBackendConnectionRequest) => Promise<LocalExecConnection | null>;

export interface LocalToolPermissionStore {
  getLocalToolPermission(): "always" | "ask" | "never";
}

export interface LocalExecDaemonProvider {
  start(): void;
  close(): void;
}

export interface RunLocalExecDaemonOptions {
  readonly connectionPath?: string;
  readonly credentialPath?: string;
  readonly supervisorHeartbeatPath?: string;
  readonly discoveryPath?: string;
  readonly approvalsPath?: string;
  readonly retirementsPath?: string;
  readonly publishDiscovery?: boolean;
  readonly settingsStore?: LocalToolPermissionStore;
  readonly executor?: LocalExecExecutor;
  readonly providerFactory?: (options: SlateLocalExecProviderOptions) => LocalExecDaemonProvider;
  readonly resolveConnectionFromBackend?: LocalExecBackendConnectionResolver;
  readonly now?: () => number;
  readonly pid?: number;
  readonly entryRealpath?: string;
  readonly generationToken?: string;
}
