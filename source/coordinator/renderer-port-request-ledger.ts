import {
  COORDINATOR_CANCELLED,
  COORDINATOR_UNKNOWN_METHOD,
  type CoordinatorFrame,
  type CoordinatorReplyOutcome,
} from "../shared/rpc/coordinator-port.ts"
import type { RendererPortServerOptions } from "./renderer-port-server-contracts.ts"

type PendingRequest = Extract<CoordinatorFrame, { kind: "request" }>

/** Dispatch live calls, project cancellation, and invalidate work when the port stops serving. */
export function createRendererPortRequestLedger(options: {
  readonly dispatchRequest: RendererPortServerOptions["dispatchRequest"]
  readonly isServing: () => boolean
  readonly postReply: (requestId: string, outcome: CoordinatorReplyOutcome) => void
  readonly breach: (detail: string) => void
}) {
  const active = new Map<string, AbortController>()

  function dispatch(request: PendingRequest): void {
    const { requestId, method, args } = request
    if (active.has(requestId)) {
      options.breach(`request.requestId ${requestId} reused while in flight`)
      return
    }

    const handler = options.dispatchRequest
    if (handler == null) {
      options.postReply(requestId, {
        status: "failed",
        failure: { code: COORDINATOR_UNKNOWN_METHOD, message: "no method table serves this session yet" },
      })
      return
    }

    const controller = new AbortController()
    active.set(requestId, controller)
    void handler(method, args, controller.signal).then(
      outcome => {
        if (!options.isServing() || active.get(requestId) !== controller) return
        active.delete(requestId)
        options.postReply(requestId, outcome)
      },
      () => options.breach(`request ${requestId} dispatch rejected instead of settling`),
    )
  }

  function cancel(requestId: string): void {
    const controller = active.get(requestId)
    if (controller === undefined) return

    active.delete(requestId)
    controller.abort()
    options.postReply(requestId, {
      status: "failed",
      failure: { code: COORDINATOR_CANCELLED, message: "request cancelled" },
    })
  }

  function abortAll(): void {
    for (const controller of active.values()) controller.abort()
    active.clear()
  }

  return { dispatch, cancel, abortAll }
}
