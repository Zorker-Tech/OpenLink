/**
 * What an upgrade left behind, and how it is reported.
 *
 * The marker is read defensively (a malformed one is no marker), its timing is turned into the durations a report
 * carries — how long the hand-off to the apply took, how long the swap took, and the total — and it is forwarded once:
 * what was already forwarded is skipped, an unparseable marker is discarded, and one that cannot be emitted is left in
 * place to be tried again. The marker is only deleted when it is still the one that was read.
 */
export interface HostUpgradeMarker { readonly outcome?: "applied" | "failed" | undefined; readonly fromVersion?: string | undefined; readonly toVersion?: string | undefined; readonly mode?: string | undefined; readonly reason?: string | undefined; readonly issuedAtMs?: number | undefined; readonly appliedAtMs?: number | undefined; readonly swapMs?: number | undefined; readonly swapError?: string | undefined }
export type HostUpgradeMetadata = Record<string, string | undefined>;
export type HostUpgradeMarkerForwardOutcome = "absent" | "skipped" | "parse_error" | "deferred" | "emitted";

/** A marker field that says something, or nothing when the field is absent or of another type. */
function markerText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A marker's numeric field, or nothing when it is absent or not a finite number. */
function markerNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The outcome a marker reports, or nothing when it reports none this platform knows. */
function markerOutcome(value: unknown): "applied" | "failed" | undefined {
  return value === "applied" || value === "failed" ? value : undefined;
}

/** Whether a moment is one a report can time from: present, and after the epoch. */
function isTimed(momentMs: number | undefined): momentMs is number {
  return momentMs != null && momentMs > 0;
}

/** How long one moment took after another, never negative, or nothing when either moment is not a timed one. */
function elapsedMs(fromMs: number | undefined, toMs: number | undefined): number | undefined {
  return isTimed(fromMs) && isTimed(toMs) ? Math.max(0, toMs - fromMs) : undefined;
}

/** How long ago a moment was at the report's time, never negative, or nothing when the moment is not a timed one. */
function elapsedSinceMs(fromMs: number | undefined, nowMs: number): number | undefined {
  return isTimed(fromMs) ? Math.max(0, nowMs - fromMs) : undefined;
}

/** A count of milliseconds as a report names it, or nothing when there is no count. */
function millisecondsText(value: number | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

/** The report an upgrade that failed carries: versions, mode, trigger, and the swap that went wrong. */
function failedUpgradeMetadata(marker: HostUpgradeMarker): HostUpgradeMetadata {
  return {
    from_version: marker.fromVersion,
    to_version: marker.toVersion,
    mode: marker.mode,
    trigger: marker.reason,
    outcome: "failed",
    phase: "swap",
    error_class: marker.swapError ?? "swap-failed",
  };
}

/** The report an upgrade that applied carries: versions, mode, trigger, and the timing it took. */
function appliedUpgradeMetadata(marker: HostUpgradeMarker, nowMs: number): HostUpgradeMetadata {
  return {
    from_version: marker.fromVersion,
    to_version: marker.toVersion,
    mode: marker.mode,
    trigger: marker.reason,
    outcome: "applied",
    deliver_to_apply_ms: millisecondsText(elapsedMs(marker.issuedAtMs, marker.appliedAtMs)),
    swap_ms: millisecondsText(marker.swapMs),
    total_ms: millisecondsText(elapsedSinceMs(marker.issuedAtMs, nowMs)),
  };
}

export function parseHostUpgradeMarker(raw: string): HostUpgradeMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const outcome = markerOutcome(record.outcome);
  const fromVersion = markerText(record.fromVersion);
  const toVersion = markerText(record.toVersion);
  const mode = markerText(record.mode);
  const reason = markerText(record.reason);
  const issuedAtMs = markerNumber(record.issuedAtMs);
  const appliedAtMs = markerNumber(record.appliedAtMs);
  const swapMs = markerNumber(record.swapMs);
  const swapError = markerText(record.swapError);
  return {
    ...(outcome === undefined ? {} : { outcome }),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    ...(toVersion === undefined ? {} : { toVersion }),
    ...(mode === undefined ? {} : { mode }),
    ...(reason === undefined ? {} : { reason }),
    ...(issuedAtMs === undefined ? {} : { issuedAtMs }),
    ...(appliedAtMs === undefined ? {} : { appliedAtMs }),
    ...(swapMs === undefined ? {} : { swapMs }),
    ...(swapError === undefined ? {} : { swapError }),
  };
}

export function computeHostUpgradeMetadata(marker: HostUpgradeMarker, nowMs: number): HostUpgradeMetadata {
  if (marker.outcome === "failed") return failedUpgradeMetadata(marker);
  return appliedUpgradeMetadata(marker, nowMs);
}

/** The collaborators a forward needs: where the marker lives, how it is reported, and what was already sent. */
interface HostUpgradeMarkerForwardDependencies {
  readRaw(): Promise<string | null>;
  deleteMarker(): Promise<void>;
  emit(metadata: HostUpgradeMetadata): Promise<boolean>;
  warn(message: string): void;
  now(raw: string): number;
  wasForwarded(raw: string): boolean;
  markForwarded(raw: string): void;
  onForwarded?(marker: HostUpgradeMarker): void;
}

/** Deletes the marker only when what is on disk is still the text that was read. */
async function deleteMarkerIfUnchanged(deps: HostUpgradeMarkerForwardDependencies, raw: string): Promise<void> {
  if (await deps.readRaw() === raw) await deps.deleteMarker();
}

export async function forwardHostUpgradeMarkerWith(deps: HostUpgradeMarkerForwardDependencies): Promise<HostUpgradeMarkerForwardOutcome> {
  const raw = await deps.readRaw();
  if (raw == null) return "absent";
  if (deps.wasForwarded(raw)) return "skipped";
  const marker = parseHostUpgradeMarker(raw);
  if (marker == null) {
    deps.warn(`discarding unparseable host-upgrade marker (len=${raw.length})`);
    deps.markForwarded(raw);
    await deleteMarkerIfUnchanged(deps, raw);
    return "parse_error";
  }
  if (!await deps.emit(computeHostUpgradeMetadata(marker, deps.now(raw)))) return "deferred";
  deps.markForwarded(raw);
  try {
    deps.onForwarded?.(marker);
  } catch {}
  await deleteMarkerIfUnchanged(deps, raw);
  return "emitted";
}
