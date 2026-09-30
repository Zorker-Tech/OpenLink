/** The host's own machine, wired as a host extension.

 * The bridge to the local-exec daemon is built here, with the permission gate the user set, the telemetry a refusal or a
 * provider reports and the approvals a retired permission takes back; what the extension hands out is the box itself,
 * the computers behind it and the two ways the daemon's connection reaches it. */
import { createIdleWatchdogPolicy, realClock } from "../extensions/scheduling.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS } from "../../shared/local-exec-gateway.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import type { GatewayLocalToolGate } from "./gateway-local-exec-slate-box.ts";
import { GatewayLocalExecBox, createBridgeUserComputers, type GatewayLocalExecCodec } from "./gateway-local-exec-slate-box.ts";
import { SlateLocalExecBridge, type LocalExecBridgeFrame } from "./local-exec-bridge.ts";

interface LocalExecLogs { reportLocalExecRefused(report: unknown): void; reportLocalExecProvider(report: unknown): void; reportLocalExecFailed(report: unknown): void; }
interface LocalExecHost { readonly events: { on(topic: string, listener: (payload: unknown) => void): () => void }; }

export function createLocalExecExtension<Client = unknown, Accessor = unknown>(codec: GatewayLocalExecCodec<Client, Accessor>) {
  return defineHostExtension<unknown, LocalExecHost>({
    id: HostExtensions.LocalExec, dependencies: [HostExtensions.LocalToolPermission, HostExtensions.Telemetry],
    start: (context) => {
      const gate = context.deps[HostExtensions.LocalToolPermission] as GatewayLocalToolGate; const logs = (context.deps[HostExtensions.Telemetry] as { readonly logs: LocalExecLogs }).logs;
      const bridge = new SlateLocalExecBridge({ clock: realClock, responseWatchdog: createIdleWatchdogPolicy(realClock, { name: "slate-local-exec-response", idleMs: SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS }), blockedReason: () => gate.blockedReason(), report: { refused: (report) => logs.reportLocalExecRefused(report), provider: (report) => logs.reportLocalExecProvider(report) } });
      const offRetirement = context.host.events.on("local-tool-permission.approval-retired", (payload) => { if (typeof payload === "object" && payload != null && typeof (payload as { approvalId?: unknown }).approvalId === "string") bridge.retireApproval((payload as { approvalId: string }).approvalId); }); context.onStop(offRetirement);
      const options = { gate, codec, reportFailure: (report: unknown) => logs.reportLocalExecFailed(report) };
      return { box: new GatewayLocalExecBox(bridge, options), userComputers: createBridgeUserComputers(bridge, options), registerProvider: (send: (frame: LocalExecBridgeFrame) => void) => bridge.registerProvider(send), submitResponses: (batch: Parameters<SlateLocalExecBridge["submitResponses"]>[0]) => bridge.submitResponses(batch), checkLiveComputerForAsk: (agentId?: string) => bridge.checkLiveComputerForAsk(agentId) };
    }
  });
}
