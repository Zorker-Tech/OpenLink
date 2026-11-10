/** Public API for filtering and relaying traffic through an egress tunnel. */

export {
  KIND_CLOSE,
  KIND_DATA,
  KIND_OPEN,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SOCKET_HIGH_WATER_MARK,
} from "./exit-client-contracts.ts";
export type { EgressFrame, EgressTunnelExitClientOptions, ExitWebSocket } from "./exit-client-contracts.ts";
export { EgressTunnelExitClient } from "./egress-tunnel-exit-client.ts";
export { decodeFrame, encodeClose, encodeData, toBuffer } from "./egress-frame-codec.ts";
export {
  embeddedV4,
  expandV6,
  isBlockedIp,
  isBlockedV4,
  isBlockedV6,
  isReservedV4,
  isSharedCgnat,
  resolveChecked,
} from "./egress-target-policy.ts";
