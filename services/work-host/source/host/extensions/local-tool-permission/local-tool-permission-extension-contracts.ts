import type { HostExtensionContext } from "../host-extensions.ts";
import type { SlateLocalToolPermission } from "../../../shared/local-tool-permission.ts";
import type { SlateLocalToolPermissionController } from "./local-tool-permission-controller.ts";
import type {
  LocalToolPermissionResolutionArgs,
  LocalToolPermissionTranscript,
} from "./local-tool-permission-resolution.ts";

export interface LocalPermissionSettingsPort {
  getLocalToolPermission(): SlateLocalToolPermission;
  setLocalToolPermission(permission: "always" | "never"): void;
}

export interface LocalPermissionTelemetryPort {
  readonly logs: {
    reportLocalToolPermissionStrandedRetirement(): void;
  };
}

export interface LocalPermissionHostPort {
  readonly events: {
    emit(topic: string, payload: unknown): Promise<void>;
  };
  readonly whenBackgroundWorkReady: Promise<void>;
  log(message: string): void;
}

export interface LocalPermissionExtensionApi extends SlateLocalToolPermissionController {
  bindAskSurfaces(provider: (agentId: string) => boolean): void;
  bindLiveComputerCheck(provider: (agentId: string) => boolean): void;
  resolveAsk(args: LocalToolPermissionResolutionArgs): Promise<void>;
}

export type LocalPermissionExtensionContext = HostExtensionContext<LocalPermissionHostPort>;
export type LocalPermissionTranscriptPort = LocalToolPermissionTranscript;
