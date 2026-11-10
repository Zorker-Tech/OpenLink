import type { CoordinatorFrame, CoordinatorReplyOutcome } from "../shared/rpc/coordinator-port.ts"

export interface RendererPort {
  post(frame: CoordinatorFrame): void
  close(): void
}

export type RendererPortSettlement =
  | { readonly outcome: "shutdown-requested" | "port-closed" }
  | { readonly outcome: "protocol-breach"; readonly detail: string }

export interface RendererPortServerOptions {
  readonly dispatchRequest?: (method: string, args: unknown, signal: AbortSignal) => Promise<CoordinatorReplyOutcome>
  readonly onServing?: () => void
}
