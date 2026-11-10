/** The host-side report shape for deciding whether a remote desktop has stopped responding. */
export const VNC_LIVENESS_CHANNEL = "slate:vnc-liveness"
export const VNC_LIVENESS_WINDOW_MS = 10_000
export const VNC_LIVENESS_MIN_IMPACTFUL_INPUTS = 3

export interface VncLivenessReport {
  readonly phase: "post_connect"
  readonly stallMs: number
  readonly keys: number
  readonly clicks: number
  readonly moves: number
  readonly inBytes: number
}

const COUNTER_FIELDS = ["stallMs", "keys", "clicks", "moves", "inBytes"] as const

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function isValidVncLivenessReport(value: unknown): value is VncLivenessReport {
  if (typeof value !== "object" || value === null) return false
  const report = value as Record<string, unknown>
  if (report.phase !== "post_connect") return false
  return COUNTER_FIELDS.every(field => isFiniteNonNegativeNumber(report[field]))
}
