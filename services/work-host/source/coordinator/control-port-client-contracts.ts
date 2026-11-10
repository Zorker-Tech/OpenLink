import type { CoordinatorFrame } from "../shared/rpc/coordinator-port.ts"

export class ControlPortCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "ControlPortCallError"
  }
}

export interface CoordinatorEndpoint {
  post(frame: CoordinatorFrame): void
  close(): void
}

export type ControlPortSettlement =
  | { readonly outcome: "shutdown-requested" | "port-closed" }
  | { readonly outcome: "protocol-breach"; readonly detail: string }
