import type { CoordinatorFrame } from "../shared/rpc/coordinator-port.ts"
import type { ControlPortSettlement } from "./control-port-client-contracts.ts"

type LifecycleDependencies = {
  readonly expectedVersion: number
  readonly post: (frame: CoordinatorFrame) => void
  readonly close: () => void
  readonly rejectPending: (settlement: ControlPortSettlement) => void
}

/** Own the one-way handshake and terminal state shared by commands, messages and shutdown. */
export function createControlPortLifecycle({ expectedVersion, post, close, rejectPending }: LifecycleDependencies) {
  let serving = true
  let readySeen = false
  const { promise: settled, resolve } = Promise.withResolvers<ControlPortSettlement>()

  function settle(result: ControlPortSettlement): void {
    if (!serving) return
    serving = false
    rejectPending(result)
    close()
    resolve(result)
  }

  function breach(detail: string): void {
    if (!serving) return
    post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail })
    settle({ outcome: "protocol-breach", detail })
  }

  function ready(version: number): void {
    if (readySeen) {
      breach("ready repeated on a live control session")
      return
    }
    if (version !== expectedVersion) {
      breach(`ready.protocolVersion ${version} is not the supported ${expectedVersion}`)
      return
    }
    readySeen = true
  }

  function peerShutdown(frame: Extract<CoordinatorFrame, { kind: "lifecycle"; phase: "shutdown" }>): void {
    settle(frame.reason === "requested"
      ? { outcome: "shutdown-requested" }
      : { outcome: "protocol-breach", detail: frame.detail ?? "peer reported a breach" })
  }

  function shutdown(): void {
    if (!serving) return
    post({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null })
    settle({ outcome: "shutdown-requested" })
  }

  return {
    get isServing() { return serving },
    settled,
    breach,
    ready,
    peerShutdown,
    peerClosed: () => settle({ outcome: "port-closed" }),
    shutdown,
  }
}
