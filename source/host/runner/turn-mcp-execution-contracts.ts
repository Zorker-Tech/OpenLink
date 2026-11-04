/** The MCP identity and opaque request facts a turn needs while gating and observing one call. */
export interface TurnMcpCall {
  readonly connectorId: string
  readonly serverId: string
  readonly callId?: string
  readonly request: unknown
}

/** A turn-facing outcome view; the interop adapter retains the encoded result until it is returned to the resource. */
export interface TurnMcpResultView {
  readonly kind: "success" | "error" | "other"
  readonly encodedResult: unknown
  appendAuthenticationNote(note: string): void
}

export interface TurnMcpExecutorPort {
  execute(context: unknown, call: TurnMcpCall, options?: unknown): Promise<TurnMcpResultView>
}

export interface TurnMcpResourceImplementation {
  execute(context: unknown, request: unknown, options?: unknown): Promise<unknown>
}
