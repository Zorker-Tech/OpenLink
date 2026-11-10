import type { BoxStoreCycleSummary } from "./box-store-sync-contracts.ts";

/** Reduces a cycle to the stable fields the telemetry reader knows how to count. */
export function boxStoreSyncCycleTelemetry(
  summary: BoxStoreCycleSummary,
): { level: "info" | "warn"; metadata: Record<string, string> } | null {
  if (!summary.ok) {
    if (summary.reason === "in-flight") return null;
    return {
      level: "warn",
      metadata: {
        ok: "false",
        reason: summary.reason === "locked" ? "locked" : "error",
        duration_ms: String(summary.durationMs),
        manifest_entries: String(summary.manifestEntries),
        store_db_entries: String(summary.storeDbEntries),
      },
    };
  }

  const counts = summary.categories.reduce((total, category) => ({
    excludedFiles: total.excludedFiles + (category.excludedFiles ?? 0),
    excludedBytes: total.excludedBytes + (category.excludedBytes ?? 0),
    prunedDirs: total.prunedDirs + (category.prunedDirs ?? 0),
  }), { excludedFiles: 0, excludedBytes: 0, prunedDirs: 0 });
  const metadata: Record<string, string> = {
    ok: "true",
    duration_ms: String(summary.durationMs),
    files_uploaded: String(summary.totalFilesUploaded),
    bytes_uploaded: String(summary.totalBytesUploaded),
    manifest_entries: String(summary.manifestEntries),
    excluded_files: String(counts.excludedFiles),
    excluded_bytes: String(counts.excludedBytes),
    pruned_dirs: String(counts.prunedDirs),
    store_db_entries: String(summary.storeDbEntries),
    store_id: summary.storeId ?? "",
    failures: String(summary.totalFailures),
  };
  for (const category of summary.categories) {
    metadata[`${category.name}_uploaded`] = String(category.filesUploaded);
    metadata[`${category.name}_bytes`] = String(category.bytesUploaded);
  }
  return { level: "info", metadata };
}

/** What a flush can promise, with the first failed layer named for the caller. */
export function evaluateBoxStoreFlush(
  summary: BoxStoreCycleSummary | null | undefined,
  options: { readonly sessionCategoryName: string },
) {
  if (summary?.ok !== true) {
    return {
      ok: false,
      manifestEntries: 0,
      storeDbEntries: 0,
      agentDirEntries: 0,
      storeDbComplete: false,
      filesUploaded: 0,
      reason: summary?.reason ?? "error",
    };
  }

  const sharedResult = {
    manifestEntries: summary.manifestEntries,
    storeDbEntries: summary.storeDbEntries,
    agentDirEntries: summary.agentDirEntries,
    storeDbComplete: summary.storeDbComplete,
    filesUploaded: summary.totalFilesUploaded,
  };
  const includesStoreDbCapture = summary.categories.some((category) => category.name === "store.db");
  if (includesStoreDbCapture && !summary.storeDbComplete) {
    return { ok: false, ...sharedResult, storeDbComplete: false, reason: "store-db-incomplete" };
  }
  if (summary.metadataFailures > 0) {
    return { ok: false, ...sharedResult, reason: "filesystem-metadata-incomplete" };
  }
  const sessionFailures = summary.categories.find((category) => category.name === options.sessionCategoryName)?.failures ?? 0;
  if (sessionFailures > 0) {
    return { ok: false, ...sharedResult, reason: "chrome-session-stage-failed" };
  }
  return { ok: true, ...sharedResult, reason: "" };
}
