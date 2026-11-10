/** Public surface for offering the host's own machine through the local-exec bridge. */
export { createBridgeUserComputers } from "./gateway-local-exec-computers.ts";
export { GatewayLocalExecBox, FALLBACK_TERMINALS_FOLDER } from "./gateway-local-exec-box.ts";
export { GatewayLocalExecManager } from "./gateway-local-exec-manager.ts";
export type {
  BoxContext,
  GatewayExecControl,
  GatewayExecServerMessage,
  GatewayLocalExecCodec,
  GatewayLocalToolGate,
  LocalExecFailureReport,
} from "./gateway-local-exec-contracts.ts";
export type { GatewayLocalExecBoxOptions } from "./gateway-local-exec-box.ts";
