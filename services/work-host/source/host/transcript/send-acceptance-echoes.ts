import { recordAcceptedSendSpans, type SendAcceptanceTrace, type SendAcceptanceTraceContext } from "./send-acceptance-tracing.ts"
import type { TranscriptEntry, TranscriptManagerLike } from "./transcript-hub.ts"

interface AcceptedEcho {
  readonly entry: TranscriptEntry
  readonly isOnActiveTranscript: boolean
}

export interface AcceptedSendEchoesOptions {
  readonly tm: TranscriptManagerLike
  readonly session: { readonly id: string }
  readonly echoEntries: readonly AcceptedEcho[]
  isAddressedChatOnScreen(): boolean
  readonly directAddressedAcceptance: boolean
  readonly clientNonce?: string
  readonly traceCtx?: SendAcceptanceTraceContext
  readonly sendTrace?: SendAcceptanceTrace
  readonly acceptedDurably: boolean
  readonly durableAppendStartEpochMs: number
  readonly durableAppendStartPerfMs: number
  readonly hostReceiptEpochMs: number
  readonly hostReceiptPerfMs: number
}

function publishAcceptedEntries(options: AcceptedSendEchoesOptions): boolean {
  const visible = options.isAddressedChatOnScreen()
  let needsAgentUpdate = false
  for (const echo of options.echoEntries) {
    if (visible && echo.isOnActiveTranscript) {
      options.tm.roster.emit({ type: "appended", entry: echo.entry })
      continue
    }
    needsAgentUpdate = true
    if (options.directAddressedAcceptance) {
      options.tm.roster.emit({ type: "appended", entry: echo.entry }, options.session.id)
    }
  }
  if (needsAgentUpdate) void options.tm.roster.emitAgentUpdate(options.session.id)
  return needsAgentUpdate
}

export function emitAcceptedSendEchoes(options: AcceptedSendEchoesOptions): void {
  const offscreen = publishAcceptedEntries(options)
  recordAcceptedSendSpans({
    ...(options.traceCtx === undefined ? {} : { traceCtx: options.traceCtx }),
    ...(options.sendTrace === undefined ? {} : { sendTrace: options.sendTrace }),
    ...(options.clientNonce === undefined ? {} : { clientNonce: options.clientNonce }),
    acceptedDurably: options.acceptedDurably,
    sessionId: options.session.id,
    durableAppendStartEpochMs: options.durableAppendStartEpochMs,
    durableAppendStartPerfMs: options.durableAppendStartPerfMs,
    hostReceiptEpochMs: options.hostReceiptEpochMs,
    hostReceiptPerfMs: options.hostReceiptPerfMs,
  })
  if (offscreen) {
    console.warn(`[slate] send raced a chat switch away from ${options.session.id}: entries persisted to the addressed store off screen`)
  }
}
