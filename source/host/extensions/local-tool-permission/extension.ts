/** Local tool permissions as a host extension: the controller is wired here, with the store it reads from. */
import { defineHostExtension } from "../host-extensions.ts";
import type { SlateLocalToolPermission } from "../../../shared/local-tool-permission.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SlateLocalToolPermissionController } from "./local-tool-permission-controller.ts";
import { resolveLocalToolPermissionAsk, type LocalToolPermissionResolutionArgs, type LocalToolPermissionTranscript } from "./local-tool-permission-resolution.ts";

interface SettingsApi { getLocalToolPermission(): SlateLocalToolPermission; setLocalToolPermission(permission: "always" | "never"): void; }
interface TelemetryApi { readonly logs: { reportLocalToolPermissionStrandedRetirement(): void } }
interface PermissionHost { readonly events: { emit(topic: string, payload: unknown): Promise<void> }; readonly whenBackgroundWorkReady: Promise<void>; log(message: string): void; }
export type LocalToolPermissionExtensionApi = SlateLocalToolPermissionController & { bindAskSurfaces(provider: (agentId: string) => boolean): void; bindLiveComputerCheck(provider: (agentId: string) => boolean): void; resolveAsk(args: LocalToolPermissionResolutionArgs): Promise<void>; };

export const localToolPermissionExtension = defineHostExtension<LocalToolPermissionExtensionApi, PermissionHost>({
  id: HostExtensions.LocalToolPermission, dependencies: [HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript],
  start: (context) => {
    const settings = context.deps[HostExtensions.Settings] as SettingsApi; const telemetry = context.deps[HostExtensions.Telemetry] as TelemetryApi; const transcript = context.deps[HostExtensions.Transcript] as LocalToolPermissionTranscript;
    let canAsk: (agentId: string) => boolean = () => false; let hasLiveComputer: (agentId: string) => boolean = () => false;
    const controller = new SlateLocalToolPermissionController({ getPermission: () => settings.getLocalToolPermission(), setPermission: (permission) => settings.setLocalToolPermission(permission), onApprovalRetired: (approvalId) => { void context.host.events.emit("local-tool-permission.approval-retired", { approvalId }); }, canAsk: (agentId) => canAsk(agentId), hasLiveComputer: (agentId) => hasLiveComputer(agentId) });
    const bootSweepStartedAtMs = Date.now(); void context.host.whenBackgroundWorkReady.then(() => transcript.widgetResponses.expireAllPendingLocalToolPermissionCards?.({ ifPendingBeforeMs: bootSweepStartedAtMs }).catch(() => context.host.log("local-tool ask boot sweep failed")));
    return Object.assign(controller, { bindAskSurfaces: (provider: (agentId: string) => boolean) => { canAsk = provider; }, bindLiveComputerCheck: (provider: (agentId: string) => boolean) => { hasLiveComputer = provider; }, resolveAsk: (args: LocalToolPermissionResolutionArgs) => resolveLocalToolPermissionAsk({ asks: controller, transcript, onStrandedRetirement: () => telemetry.logs.reportLocalToolPermissionStrandedRetirement() }, args) });
  }
});
