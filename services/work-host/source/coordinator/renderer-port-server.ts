import {
  COORDINATOR_PROTOCOL_VERSION,
  parseCoordinatorFrame,
  type CoordinatorFrame,
  type CoordinatorReplyOutcome,
} from "../shared/rpc/coordinator-port.ts"
import { createRendererPortRequestLedger } from "./renderer-port-request-ledger.ts"
import type { RendererPort, RendererPortServerOptions, RendererPortSettlement } from "./renderer-port-server-contracts.ts"

export type { RendererPort, RendererPortServerOptions, RendererPortSettlement } from "./renderer-port-server-contracts.ts"

type SessionPhase = "awaiting-hello" | "serving" | "settled"

export function createRendererPortServer(port: RendererPort, options: RendererPortServerOptions = {}) {
  let phase: SessionPhase = "awaiting-hello"
  let abortRequests = () => {}
  const { promise: settled, resolve } = Promise.withResolvers<RendererPortSettlement>()

  function settle(result: RendererPortSettlement): void {
    if (phase === "settled") return
    phase = "settled"
    abortRequests()
    port.close()
    resolve(result)
  }

  function breach(detail: string): void {
    if (phase === "settled") return
    port.post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail })
    settle({ outcome: "protocol-breach", detail })
  }

  function postReply(requestId: string, outcome: CoordinatorReplyOutcome): void {
    port.post({ kind: "reply", requestId, outcome })
  }

  const requests = createRendererPortRequestLedger({
    dispatchRequest: options.dispatchRequest,
    isServing: () => phase === "serving",
    postReply,
    breach,
  })
  abortRequests = requests.abortAll

  function acceptHello(protocolVersion: number): void {
    if (protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
      breach(`hello.protocolVersion ${protocolVersion} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`)
      return
    }
    phase = "serving"
    port.post({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION })
    options.onServing?.()
  }

  function handleFrame(frame: CoordinatorFrame): void {
    if (frame.kind === "lifecycle") {
      if (frame.phase === "shutdown") {
        settle({ outcome: "shutdown-requested" })
      } else if (frame.phase === "ready") {
        breach("client posted a server-direction ready frame")
      } else if (phase === "awaiting-hello") {
        acceptHello(frame.protocolVersion)
      } else {
        breach("hello repeated on a live session")
      }
      return
    }

    if (frame.kind === "reply" || frame.kind === "event") {
      breach(`client posted a server-direction ${frame.kind} frame`)
      return
    }

    if (phase === "awaiting-hello") {
      breach(`${frame.kind} frame before hello`)
      return
    }
    if (phase !== "serving") return

    if (frame.kind === "request") requests.dispatch(frame)
    else requests.cancel(frame.requestId)
  }

  return {
    handleMessage(value: unknown): void {
      if (phase === "settled") return
      const parsed = parseCoordinatorFrame(value)
      if (!parsed.accepted) {
        breach(parsed.rejection.detail)
        return
      }
      handleFrame(parsed.frame)
    },
    handlePortClosed(): void { settle({ outcome: "port-closed" }) },
    postEvent(family: string, payload: unknown): void {
      if (phase === "serving") port.post({ kind: "event", family, payload })
    },
    settled,
  }
}
