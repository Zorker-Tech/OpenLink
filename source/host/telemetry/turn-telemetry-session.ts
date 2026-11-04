import { slateErrorTags, type SlateErrorValue } from "../../shared/errors/registry.ts"
import { TURN_OUTCOME_DETAIL_EVENT, TURN_OUTCOME_EVENT, TURN_START_EVENT } from "../../shared/observability/telemetry-events.ts"

export type TurnTelemetryMetadata = Record<string, string | undefined>

export interface TurnTelemetrySink {
  emitTurnEvent(event: string, metadata: TurnTelemetryMetadata): void
}

export interface TurnTelemetryStart {
  readonly conversationId: string
  readonly turnType: string
  readonly model?: string
}

export type TurnErrorDetailProjector = (
  error: SlateErrorValue,
  detail: { readonly message: string; readonly stack?: string },
) => TurnTelemetryMetadata

interface TurnLedger {
  readonly openedAt: number
  readonly conversationId: string
  readonly turnType: string
  modelIntent?: string
  requestId?: string
  startSent: boolean
  closed: boolean
  retryCount: number
  totalBackoffMs: number
  lastRetryCause?: string
}

export class SlateTurnTelemetryImpl {
  readonly #ledger: TurnLedger

  constructor(
    private readonly sink: TurnTelemetrySink,
    start: TurnTelemetryStart,
    private readonly onFinalized: () => void,
    private readonly projectErrorDetail: TurnErrorDetailProjector,
  ) {
    this.#ledger = {
      openedAt: Date.now(),
      conversationId: start.conversationId,
      turnType: start.turnType,
      startSent: false,
      closed: false,
      retryCount: 0,
      totalBackoffMs: 0,
      ...(start.model === undefined ? {} : { modelIntent: start.model }),
    }
    if (this.#ledger.modelIntent !== undefined) this.#announceStart()
  }

  noteRetry(report: Record<string, unknown>): void {
    if (this.#ledger.closed) return
    this.#ledger.retryCount += 1
    this.#ledger.totalBackoffMs += typeof report.delayMs === "number" ? report.delayMs : 0
    if (typeof report.cause === "string") this.#ledger.lastRetryCause = report.cause
  }

  setModel(modelId: string): void {
    if (modelId.length === 0) return
    this.#ledger.modelIntent = modelId
    this.#announceStart()
  }

  setRequestId(requestId: string): void {
    if (this.#ledger.requestId === undefined && requestId.length > 0) this.#ledger.requestId = requestId
  }

  finalize(outcome: string, error?: SlateErrorValue, detail?: { readonly message: string; readonly stack?: string }): void {
    if (this.#ledger.closed) return
    this.#ledger.closed = true
    this.onFinalized()
    this.#announceStart()

    const report: TurnTelemetryMetadata = {
      ...this.baseTags(),
      outcome: error !== undefined ? "error" : outcome,
      duration_ms: String(Date.now() - this.#ledger.openedAt),
    }
    if (this.#ledger.retryCount > 0) {
      report.retry_count = String(this.#ledger.retryCount)
      report.backoff_total_ms = String(Math.round(this.#ledger.totalBackoffMs))
      report.retry_cause = this.#ledger.lastRetryCause
    }
    if (error !== undefined) Object.assign(report, slateErrorTags(error))
    this.sink.emitTurnEvent(TURN_OUTCOME_EVENT, report)

    if (error !== undefined && detail !== undefined) {
      this.sink.emitTurnEvent(TURN_OUTCOME_DETAIL_EVENT, {
        ...this.baseTags(),
        ...this.projectErrorDetail(error, detail),
      })
    }
  }

  baseTags(): TurnTelemetryMetadata {
    const { turnType, conversationId, requestId, modelIntent } = this.#ledger
    return {
      turn_type: turnType,
      conversation_id: conversationId,
      request_id: requestId,
      model_intent: modelIntent,
    }
  }

  #announceStart(): void {
    if (this.#ledger.startSent) return
    this.#ledger.startSent = true
    this.sink.emitTurnEvent(TURN_START_EVENT, this.baseTags())
  }
}
