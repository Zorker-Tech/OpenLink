import { HostExtensions } from "../extension-ids.generated.ts";
import { SlateLocalToolPermissionController } from "./local-tool-permission-controller.ts";
import {
  resolveLocalToolPermissionAsk,
  type LocalToolPermissionResolutionArgs,
} from "./local-tool-permission-resolution.ts";
import type {
  LocalPermissionExtensionApi,
  LocalPermissionExtensionContext,
  LocalPermissionSettingsPort,
  LocalPermissionTelemetryPort,
  LocalPermissionTranscriptPort,
} from "./local-tool-permission-extension-contracts.ts";

const APPROVAL_RETIRED_TOPIC = "local-tool-permission.approval-retired";
const BOOT_SWEEP_FAILURE_LOG = "local-tool ask boot sweep failed";

function startPendingAskSweep(
  ready: Promise<void>,
  transcript: LocalPermissionTranscriptPort,
  log: (message: string) => void,
): void {
  const cutoffMs = Date.now();
  void ready.then(() =>
    transcript.widgetResponses.expireAllPendingLocalToolPermissionCards?.({
      ifPendingBeforeMs: cutoffMs,
    }).catch(() => log(BOOT_SWEEP_FAILURE_LOG)),
  );
}

export function startLocalPermissionExtension(
  context: LocalPermissionExtensionContext,
): LocalPermissionExtensionApi {
  const settings = context.deps[HostExtensions.Settings] as LocalPermissionSettingsPort;
  const telemetry = context.deps[HostExtensions.Telemetry] as LocalPermissionTelemetryPort;
  const transcript = context.deps[HostExtensions.Transcript] as LocalPermissionTranscriptPort;

  let askSurfaceIsAvailable: (agentId: string) => boolean = () => false;
  let computerIsConnected: (agentId: string) => boolean = () => false;

  const controller = new SlateLocalToolPermissionController({
    getPermission: () => settings.getLocalToolPermission(),
    setPermission: (permission) => settings.setLocalToolPermission(permission),
    onApprovalRetired: (approvalId) => {
      void context.host.events.emit(APPROVAL_RETIRED_TOPIC, { approvalId });
    },
    canAsk: (agentId) => askSurfaceIsAvailable(agentId),
    hasLiveComputer: (agentId) => computerIsConnected(agentId),
  });

  startPendingAskSweep(
    context.host.whenBackgroundWorkReady,
    transcript,
    (message) => context.host.log(message),
  );

  return Object.assign(controller, {
    bindAskSurfaces: (provider: (agentId: string) => boolean) => {
      askSurfaceIsAvailable = provider;
    },
    bindLiveComputerCheck: (provider: (agentId: string) => boolean) => {
      computerIsConnected = provider;
    },
    resolveAsk: (args: LocalToolPermissionResolutionArgs) => resolveLocalToolPermissionAsk({
      asks: controller,
      transcript,
      onStrandedRetirement: () =>
        telemetry.logs.reportLocalToolPermissionStrandedRetirement(),
    }, args),
  });
}
