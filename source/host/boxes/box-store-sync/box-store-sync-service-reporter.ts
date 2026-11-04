/** Maps store outcomes to the host's telemetry fields. */
import { errorMessage } from "../../../shared/errors/summary.ts";
import { boxStoreDbCaptureTelemetry } from "./store-db-capture.ts";
import { boxStoreSyncCycleTelemetry } from "./box-store-sync.ts";
import type { BoxStoreCaptureSummary, BoxStoreCycleSummary } from "./box-store-sync.ts";
import type { ChromeStageReport } from "./chrome-session-stage.ts";
import type { BoxStoreTelemetry } from "./box-store-sync-service-contracts.ts";

export class BoxStoreSyncServiceReporter {
  constructor(private readonly telemetry: BoxStoreTelemetry) {}

  chromeSessionStage(outcome: ChromeStageReport): void {
    const failure = outcome.failure;
    this.telemetry.reportChromeSessionStage(outcome.skipped > 0 ? "warn" : "info", {
      staged: String(outcome.staged),
      skipped: String(outcome.skipped),
      skipped_dbs: outcome.skippedDbNames.length > 0 ? outcome.skippedDbNames.join(",") : undefined,
      error_class: outcome.errorClass ?? undefined,
      failure_db: failure?.db,
      failure_phase: failure?.phase,
      failure_operation: failure?.operation,
      failure_path_stage: failure?.pathStage,
      failure_cause: failure?.cause,
      errno: failure?.errno,
      sqlite_code: failure?.sqliteCode === undefined ? undefined : String(failure.sqliteCode),
    });
  }

  storeCycle(summary: BoxStoreCycleSummary): void {
    const event = boxStoreSyncCycleTelemetry(summary);
    if (event !== null) this.telemetry.reportBoxStoreSyncCycle(event.level, event.metadata);
  }

  manifestConflict(info: Record<string, unknown>): void {
    this.telemetry.reportBoxStoreManifestConflict("warn", {
      store_id: info.storeId as string,
      attempts: String(info.attempts),
      accepted: String(info.accepted),
      covered: String(info.covered),
      canonical_matches_attempt: String(info.canonicalMatchesAttempt),
      live_view_changed: String(info.liveViewChanged),
      attempted_entries: String(info.attemptedEntries),
      last_base_etag: info.lastBaseEtag as string | undefined,
      last_baseline_source: info.lastBaselineSource as string | undefined,
      last_conflict_rel_path: info.lastConflictRelPath as string | undefined,
      canonical_readable: String(info.canonicalReadable),
      canonical_entry_count: info.canonicalEntryCount == null ? undefined : String(info.canonicalEntryCount),
      canonical_updated_at_ms: info.canonicalUpdatedAtMs == null ? undefined : String(info.canonicalUpdatedAtMs),
      canonical_writer_window_id: info.canonicalWriterWindowId as string | undefined,
      our_window_id: info.ourWindowId as string | undefined,
    });
  }

  storeDbCapture(summary: BoxStoreCaptureSummary): void {
    const event = boxStoreDbCaptureTelemetry(summary);
    this.telemetry.reportBoxStoreDbCapture(event.level, event.metadata);
  }

  logFailure(prefix: string, error: unknown, log: (message: string) => void): void {
    log(`${prefix}: ${errorMessage(error)}`);
  }
}
