import { createSendEchoLedger } from "./transport-stage-echo-ledger.ts"
import { createBoundedReportForwarder } from "./transport-stage-egress.ts"
import type { StageTrace, TransportIdentity, TransportStageRecorderOptions, TransportStageReport } from "./transport-stage-recorder-contracts.ts"

export type { TransportIdentity, TransportStageEgress, TransportStageReport } from "./transport-stage-recorder-contracts.ts"

export const SSE_ECHO_STAGE = "echo-coordinator-sse"
export const MAX_IN_FLIGHT_TRANSPORT_REPORTS = 64
export const PENDING_SEND_ECHO_MAX = 64
export const PENDING_SEND_ECHO_TTL_MS = 120_000

const INERT_STAGE = { complete() {}, fail() {} }
const INERT_TRACE: StageTrace = { beginStage: () => INERT_STAGE, markStage() {} }

function reportOf(
  identity: { readonly accountSlot: string; readonly clientNonce: string },
  stage: string,
  attempt: number,
  traceparent: string | null,
  startEpochMs: number,
  durationMs: number,
  isError: boolean,
): TransportStageReport {
  return { ...identity, stage, attempt, traceparent, startEpochMs, durationMs, isError }
}

export function createTransportStageRecorder(options: TransportStageRecorderOptions) {
  const { clock, egress } = options
  const forward = createBoundedReportForwarder(MAX_IN_FLIGHT_TRANSPORT_REPORTS)
  const reportStage = (report: TransportStageReport) => forward(() => egress.reportTransportStage(report))
  const echoes = createSendEchoLedger({
    clock,
    maximumEntries: PENDING_SEND_ECHO_MAX,
    lifetimeMs: PENDING_SEND_ECHO_TTL_MS,
    onEcho: (identity, traceparent) => reportStage(reportOf(
      identity,
      SSE_ECHO_STAGE,
      0,
      traceparent,
      clock.now(),
      0,
      false,
    )),
  })

  function beginSend(identity: TransportIdentity): StageTrace {
    const { accountSlot, clientNonce, traceparent } = identity
    if (clientNonce == null || clientNonce === "") return INERT_TRACE

    const requestIdentity = { accountSlot, clientNonce }
    const sampledTraceparent = traceparent == null || traceparent === "" ? null : traceparent
    if (sampledTraceparent !== null) echoes.arm(requestIdentity, sampledTraceparent)

    return {
      beginStage(stage: string, attempt: number) {
        const startEpochMs = clock.now()
        const startedAt = clock.monotonicNow()
        let finished = false

        const settle = (isError: boolean) => {
          if (finished) return
          finished = true
          reportStage(reportOf(
            requestIdentity,
            stage,
            attempt,
            sampledTraceparent,
            startEpochMs,
            clock.monotonicNow() - startedAt,
            isError,
          ))
        }
        return { complete: () => settle(false), fail: () => settle(true) }
      },
      markStage(stage: string, attempt: number) {
        reportStage(reportOf(requestIdentity, stage, attempt, sampledTraceparent, clock.now(), 0, false))
      },
    }
  }

  return {
    beginSend,
    recordSendEcho(identity: { readonly accountSlot: string; readonly clientNonce: string }) {
      echoes.consume(identity)
    },
    recordTransportStage: reportStage,
    recordGatewayCommandSpan(report: unknown) { forward(() => egress.reportGatewayCommandSpan(report)) },
    recordGatewayReachability(report: unknown) { forward(() => egress.reportGatewayReachability(report)) },
    recordGatewayDnsDiagnostic(report: unknown) { forward(() => egress.reportGatewayDnsDiagnostic(report)) },
  }
}
