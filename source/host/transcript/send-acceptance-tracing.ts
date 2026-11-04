export interface SendAcceptanceTraceContext {
  withName(name: string): unknown
}

export interface SendAcceptanceTrace {
  readonly span: { setAttribute(key: string, value: unknown): void }
}

export type CompletedSpanRecorder = (
  context: unknown,
  options: {
    readonly startTime: Date
    readonly attributes: Readonly<Record<string, unknown>>
  },
  endTime: Date,
) => void

let completedSpanRecorder: CompletedSpanRecorder | undefined

export function setSendAcceptanceCompletedSpanRecorder(
  recorder: CompletedSpanRecorder | undefined,
): void {
  completedSpanRecorder = recorder
}

export function recordAcceptedSendSpans(args: {
  readonly traceCtx?: SendAcceptanceTraceContext
  readonly sendTrace?: SendAcceptanceTrace
  readonly clientNonce?: string
  readonly acceptedDurably: boolean
  readonly sessionId: string
  readonly durableAppendStartEpochMs: number
  readonly durableAppendStartPerfMs: number
  readonly hostReceiptEpochMs: number
  readonly hostReceiptPerfMs: number
}): void {
  if (args.traceCtx === undefined || completedSpanRecorder === undefined) return

  try {
    const nonce = args.clientNonce != null && args.clientNonce.length > 0
      ? { "slate.client_nonce": args.clientNonce }
      : {}
    const durableDuration = Math.max(0, Math.round(performance.now() - args.durableAppendStartPerfMs))
    completedSpanRecorder(
      args.traceCtx.withName("durable-append"),
      {
        startTime: new Date(args.durableAppendStartEpochMs),
        attributes: {
          "slate.durable_append_ms": durableDuration,
          "slate.durable": args.acceptedDurably,
          "slate.conversation_id": args.sessionId,
          ...nonce,
        },
      },
      new Date(args.durableAppendStartEpochMs + durableDuration),
    )

    const acknowledgementDuration = Math.max(0, Math.round(performance.now() - args.hostReceiptPerfMs))
    completedSpanRecorder(
      args.traceCtx.withName("send-ack-emit"),
      {
        startTime: new Date(args.hostReceiptEpochMs),
        attributes: {
          "slate.ack_emit_host_ms": acknowledgementDuration,
          "slate.conversation_id": args.sessionId,
          ...nonce,
        },
      },
      new Date(args.hostReceiptEpochMs + acknowledgementDuration),
    )
    args.sendTrace?.span.setAttribute("slate.ack_emit_host_ms", acknowledgementDuration)
  } catch {
    // Measurement failures never interrupt a send that has already been accepted.
  }
}
