import type { CoordinatorFrame, CoordinatorReplyOutcome } from "../shared/rpc/coordinator-port.ts"
import { ControlPortCallError, type ControlPortSettlement } from "./control-port-client-contracts.ts"

type WaitingCall = { resolve(value: unknown): void; reject(error: unknown): void }

/** Match replies to calls in issue order without retaining completed or abandoned work. */
export function createControlPortCallLedger(post: (frame: CoordinatorFrame) => void) {
  const waitingCalls = new Map<string, WaitingCall>()
  let sequence = 0

  function invoke(method: string, args: unknown): Promise<unknown> {
    sequence += 1
    const requestId = `c-${sequence}`
    const response = new Promise<unknown>((resolve, reject) => waitingCalls.set(requestId, { resolve, reject }))
    post({ kind: "request", requestId, method, args })
    return response
  }

  function receive(requestId: string, outcome: CoordinatorReplyOutcome): void {
    const waiting = waitingCalls.get(requestId)
    if (waiting === undefined) return

    waitingCalls.delete(requestId)
    if (outcome.status === "ok") waiting.resolve(outcome.value)
    else waiting.reject(new ControlPortCallError(outcome.failure.code, outcome.failure.message))
  }

  function rejectAll(settlement: ControlPortSettlement): void {
    for (const waiting of waitingCalls.values()) {
      waiting.reject(new Error(`control port settled (${settlement.outcome}) before the reply`))
    }
    waitingCalls.clear()
  }

  return { invoke, receive, rejectAll }
}
