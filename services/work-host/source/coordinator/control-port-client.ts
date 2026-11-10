import {
  COORDINATOR_PROTOCOL_VERSION,
  parseCoordinatorFrame,
  type CoordinatorFrame,
} from "../shared/rpc/coordinator-port.ts"
import { createControlPortCallLedger } from "./control-port-call-ledger.ts"
import { createControlPortLifecycle } from "./control-port-client-lifecycle.ts"
import type { CoordinatorEndpoint } from "./control-port-client-contracts.ts"

export { ControlPortCallError } from "./control-port-client-contracts.ts"
export type { CoordinatorEndpoint, ControlPortSettlement } from "./control-port-client-contracts.ts"

export function createControlPortClient(endpoint: CoordinatorEndpoint) {
  const send = (frame: CoordinatorFrame) => endpoint.post(frame)
  const calls = createControlPortCallLedger(send)
  const lifecycle = createControlPortLifecycle({
    expectedVersion: COORDINATOR_PROTOCOL_VERSION,
    post: send,
    close: () => endpoint.close(),
    rejectPending: calls.rejectAll,
  })

  send({ kind: "lifecycle", phase: "hello", protocolVersion: COORDINATOR_PROTOCOL_VERSION })

  const commands = new Proxy({} as Record<string, (args: unknown) => Promise<unknown>>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined
      return (args: unknown) => lifecycle.isServing
        ? calls.invoke(property, args)
        : Promise.reject(new Error(`control port settled before ${property} was posted`))
    },
  })

  function acceptFrame(frame: CoordinatorFrame): void {
    if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
      lifecycle.peerShutdown(frame)
      return
    }
    if (frame.kind === "lifecycle" && frame.phase === "ready") {
      lifecycle.ready(frame.protocolVersion)
      return
    }
    if (frame.kind === "reply") {
      calls.receive(frame.requestId, frame.outcome)
      return
    }
    lifecycle.breach(`main posted a client-direction ${frame.kind} frame`)
  }

  return {
    commands,
    postEvent(family: string, payload: unknown): void {
      if (lifecycle.isServing) send({ kind: "event", family, payload })
    },
    handleMessage(value: unknown): void {
      if (!lifecycle.isServing) return
      const parsed = parseCoordinatorFrame(value)
      if (!parsed.accepted) {
        lifecycle.breach(parsed.rejection.detail)
        return
      }
      acceptFrame(parsed.frame)
    },
    handlePortClosed: lifecycle.peerClosed,
    shutdown: lifecycle.shutdown,
    settled: lifecycle.settled,
  }
}
