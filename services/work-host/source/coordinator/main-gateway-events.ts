import { COORDINATOR_TRANSPORT_STATE_FAMILY } from "../shared/rpc/coordinator-port.ts"
import { familyOnChannel } from "./gateway/gateway-event-families.ts"
import { parsePendingMcpAuthorization, recordTranscriptEcho, type PendingMcpAuthorization } from "./main-policies.ts"

export interface CoordinatorGatewayNotice {
  readonly channel: string
  readonly payload: unknown
}

export interface CoordinatorGatewayNoticePorts {
  readonly authorizationListeners: ReadonlySet<(pending: PendingMcpAuthorization) => void>
  readonly echoRecorder: { recordSendEcho(key: { accountSlot: string; clientNonce: string }): void }
  readonly toolRelay: { accept(payload: unknown): void }
  readonly controlEvents: { postEvent(family: string, payload: unknown): void }
  readonly rendererEvents: { postEvent(family: string, payload: unknown): void }
}

const CONTROL_EVENT_ROUTE = new Map<string, { readonly family: string; readonly kind: string }>([
  ["agents", { family: "agents-event", kind: "agents" }],
  ["agent-upserted", { family: "agents-event", kind: "agent-upserted" }],
])

/** Deliver a gateway notice to the local surface that owns it. */
export function routeCoordinatorGatewayNotice(
  notice: CoordinatorGatewayNotice,
  ports: CoordinatorGatewayNoticePorts,
): void {
  if (notice.channel === "mcp-oauth-pending") {
    const pending = parsePendingMcpAuthorization(notice.payload)
    if (pending !== undefined) for (const listener of ports.authorizationListeners) listener(pending)
    return
  }
  if (notice.channel === "client-side-tool-v2") {
    ports.toolRelay.accept(notice.payload)
    return
  }
  if (notice.channel === "transcript") recordTranscriptEcho(notice.payload, ports.echoRecorder)

  const controlRoute = CONTROL_EVENT_ROUTE.get(notice.channel)
  if (controlRoute !== undefined) {
    ports.controlEvents.postEvent(controlRoute.family, { kind: controlRoute.kind, event: notice.payload })
  }
  const rendererFamily = familyOnChannel(notice.channel)
  if (rendererFamily !== undefined && rendererFamily !== null) {
    ports.rendererEvents.postEvent(rendererFamily, notice.payload)
  }
}

export interface CoordinatorTransportSignalPorts {
  readonly controlEvents: { postEvent(family: string, payload: unknown): void }
  readonly invalidateHealth: () => void
  readonly refreshLocalExec: () => Promise<unknown>
  readonly seedAgentRoster: () => Promise<void>
  readonly rendererEvents: { postEvent(family: string, payload: unknown): void }
}

/** Apply a transport transition and return the stream's new live state. */
export function applyCoordinatorTransportSignal(
  raw: unknown,
  ports: CoordinatorTransportSignalPorts,
): boolean | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const event = raw as { readonly family: string; readonly payload: unknown }
  ports.controlEvents.postEvent(event.family, event.payload)
  if (event.family === "transport-down") {
    ports.invalidateHealth()
    ports.rendererEvents.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" })
    return false
  }
  void ports.refreshLocalExec()
  void ports.seedAgentRoster()
  ports.rendererEvents.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" })
  return true
}

export async function seedCoordinatorAgentRoster(
  dispatchList: () => Promise<unknown>,
  post: (family: string, payload: unknown) => void,
  reportFailure: (message: string) => void,
): Promise<void> {
  try {
    const agents = await dispatchList()
    post("agents-roster-seed", { agents })
  } catch (error) {
    reportFailure(`agents roster seed skipped: ${String(error)}`)
  }
}
