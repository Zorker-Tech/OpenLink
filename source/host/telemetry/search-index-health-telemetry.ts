export const SEARCH_INDEX_HEALTH_EVENT = "slate.search_index.health";

export const SEARCH_INDEX_WARN_KINDS = new Set([
  "dispose_drain_cut",
  "worker_terminate_failed",
  "job_retry",
]);

interface IndexProblem {
  kind: string;
  stage?: string;
  errorClass?: string;
}

interface IndexMeasure {
  count?: number | null;
}

export interface SearchIndexHealthReport extends IndexProblem, IndexMeasure {}

function levelFor(kind: string): "warn" | "error" {
  return SEARCH_INDEX_WARN_KINDS.has(kind) ? "warn" : "error";
}

function countMetadata(count: number | null | undefined): string | undefined {
  return count == null ? undefined : String(count);
}

function healthMetadata(report: SearchIndexHealthReport) {
  return {
    kind: report.kind,
    stage: report.stage,
    error_class: report.errorClass,
    count: countMetadata(report.count),
  };
}

export function searchIndexHealthTelemetry(report: SearchIndexHealthReport) {
  return {
    level: levelFor(report.kind),
    event: SEARCH_INDEX_HEALTH_EVENT,
    metadata: healthMetadata(report),
  };
}
