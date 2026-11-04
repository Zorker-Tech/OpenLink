import { createIdleWatchdogPolicy, realClock } from "../extensions/scheduling.ts"
import type { HostExtensionContext } from "../extensions/host-extensions.ts"
import { SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS } from "../../shared/local-exec-gateway.ts"
import { HostExtensions } from "../extensions/extension-ids.generated.ts"
import type { GatewayLocalToolGate } from "./gateway-local-exec-slate-box.ts"
import type { GatewayLocalExecCodec } from "./gateway-local-exec-slate-box.ts"
import { SlateLocalExecBridge } from "./local-exec-bridge.ts"
import type { LocalExecExtensionHost } from "./local-exec-extension-contracts.ts"

interface LocalExecLogs {
  reportLocalExecRefused(report: unknown): void
  reportLocalExecProvider(report: unknown): void
  reportLocalExecFailed(report: unknown): void
}

export interface LocalExecBridgeBinding<Client, Accessor> {
  readonly bridge: SlateLocalExecBridge
  readonly options: {
    readonly gate: GatewayLocalToolGate
    readonly codec: GatewayLocalExecCodec<Client, Accessor>
    readonly reportFailure: (report: unknown) => void
  }
}

export function startLocalExecBridge<Client, Accessor>(
  context: HostExtensionContext<LocalExecExtensionHost>,
  codec: GatewayLocalExecCodec<Client, Accessor>,
): LocalExecBridgeBinding<Client, Accessor> {
  const gate = context.deps[HostExtensions.LocalToolPermission] as GatewayLocalToolGate
  const logs = (context.deps[HostExtensions.Telemetry] as { readonly logs: LocalExecLogs }).logs
  const bridge = new SlateLocalExecBridge({
    clock: realClock,
    responseWatchdog: createIdleWatchdogPolicy(realClock, {
      name: "slate-local-exec-response",
      idleMs: SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS,
    }),
    blockedReason: () => gate.blockedReason(),
    report: {
      refused: report => logs.reportLocalExecRefused(report),
      provider: report => logs.reportLocalExecProvider(report),
    },
  })
  const unsubscribe = context.host.events.on(
    "local-tool-permission.approval-retired",
    payload => retireApprovalFromEvent(payload, bridge),
  )
  context.onStop(unsubscribe)

  return {
    bridge,
    options: {
      gate,
      codec,
      reportFailure: report => logs.reportLocalExecFailed(report),
    },
  }
}

function retireApprovalFromEvent(payload: unknown, bridge: SlateLocalExecBridge): void {
  if (typeof payload !== "object" || payload === null) return
  const approvalId = (payload as { readonly approvalId?: unknown }).approvalId
  if (typeof approvalId === "string") bridge.retireApproval(approvalId)
}
