export class FusedStepGuardTimeoutError extends Error {
  readonly fuseGuardMs: number

  constructor(fuseGuardMs: number) {
    super(`The combined model and tool step exceeded its ${Math.round(fuseGuardMs / 1_000)}-second guard limit`)
    this.name = "FusedStepGuardTimeoutError"
    this.fuseGuardMs = fuseGuardMs
  }
}

export function isFusedStepGuardTimeoutReason(reason: unknown): reason is FusedStepGuardTimeoutError {
  return reason instanceof FusedStepGuardTimeoutError
    || (reason instanceof Error
      && reason.name === "FusedStepGuardTimeoutError"
      && "fuseGuardMs" in reason
      && typeof reason.fuseGuardMs === "number")
}
