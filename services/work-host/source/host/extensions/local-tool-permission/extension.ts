import { defineHostExtension } from "../host-extensions.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import type {
  LocalPermissionExtensionApi,
  LocalPermissionHostPort,
} from "./local-tool-permission-extension-contracts.ts";
import { startLocalPermissionExtension } from "./local-tool-permission-extension-runtime.ts";

export const localToolPermissionExtension = defineHostExtension<
  LocalPermissionExtensionApi,
  LocalPermissionHostPort
>({
  id: HostExtensions.LocalToolPermission,
  dependencies: [
    HostExtensions.Settings,
    HostExtensions.Telemetry,
    HostExtensions.Transcript,
  ],
  start: startLocalPermissionExtension,
});
