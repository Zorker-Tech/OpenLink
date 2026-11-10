export type HandoffReason = "auth" | "captcha" | "payment" | "other"

export type HandoffRequestResult =
  | { readonly kind: "already-pending"; readonly requestId: string; readonly instruction: string }
  | { readonly kind: "started"; readonly requestId: string }

export interface ManualHandoffPorts {
  getAgentId(): string | undefined
  endTurn(): void
  requestHelp(request: {
    readonly agentId: string
    readonly instruction: string
    readonly telemetry: {
      readonly reason?: HandoffReason
      readonly domain?: string
      readonly idpDomain?: string
    }
  }): Promise<HandoffRequestResult>
  onSendMessage(
    message: { readonly type: "text"; readonly content: string },
    timestampMs: number,
    metadata: { readonly requestId: string; readonly instruction: string },
  ): void
  now?: () => number
}
