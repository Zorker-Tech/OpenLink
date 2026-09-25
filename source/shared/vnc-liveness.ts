/**
 * Whether a remote desktop is actually responding.
 *
 * A connection can be up while the picture is frozen, so what the user did and what came back are compared over a
 * window: a session with enough real input and no bytes arriving is stalled, and a report that is not a bounded count
 * is not a report.
 */
export const VNC_LIVENESS_CHANNEL = "slate:vnc-liveness";
export const VNC_LIVENESS_WINDOW_MS = 10_000;
export const VNC_LIVENESS_MIN_IMPACTFUL_INPUTS = 3;

export interface VncLivenessReport {
  readonly phase: "post_connect";
  readonly stallMs: number;
  readonly keys: number;
  readonly clicks: number;
  readonly moves: number;
  readonly inBytes: number;
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidVncLivenessReport(value: unknown): value is VncLivenessReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return report.phase === "post_connect"
    && isBoundedCount(report.stallMs)
    && isBoundedCount(report.keys)
    && isBoundedCount(report.clicks)
    && isBoundedCount(report.moves)
    && isBoundedCount(report.inBytes);
}
