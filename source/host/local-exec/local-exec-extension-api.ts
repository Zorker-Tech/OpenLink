import { createBridgeUserComputers, GatewayLocalExecBox } from "./gateway-local-exec-slate-box.ts"
import type { GatewayLocalExecCodec, GatewayLocalToolGate } from "./gateway-local-exec-slate-box.ts"
import type { LocalExecBridgeFrame } from "./local-exec-bridge.ts"
import type { SlateLocalExecBridge } from "./local-exec-bridge.ts"

export function createLocalExecExtensionApi<Client, Accessor>(
  bridge: SlateLocalExecBridge,
  options: {
    readonly gate: GatewayLocalToolGate
    readonly codec: GatewayLocalExecCodec<Client, Accessor>
    readonly reportFailure: (report: unknown) => void
  },
) {
  return {
    box: new GatewayLocalExecBox(bridge, options),
    userComputers: createBridgeUserComputers(bridge, options),
    registerProvider: (send: (frame: LocalExecBridgeFrame) => void) => bridge.registerProvider(send),
    submitResponses: (batch: Parameters<SlateLocalExecBridge["submitResponses"]>[0]) => bridge.submitResponses(batch),
    checkLiveComputerForAsk: (agentId?: string) => bridge.checkLiveComputerForAsk(agentId),
  }
}
