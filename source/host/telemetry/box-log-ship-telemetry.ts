export const BOX_LOG_SHIP_EVENT = "slate.box.log_ship";

interface ShippingProgress {
  readonly kind: "progress";
  readonly bytesWritten: number;
  readonly bytesDelivered: number;
  readonly pendingWindowCount: number;
  readonly oldestPendingWindowAgeMs: number;
}

interface OffsetSaveStatus {
  readonly kind: "save_failed" | "save_recovered";
  readonly errorClass: string;
  readonly failureCount: number;
}

export type BoxLogShipReport = ShippingProgress | OffsetSaveStatus;

function countFields(fields: readonly (readonly [string, number])[]): Record<string, string> {
  return Object.fromEntries(fields.map(([name, count]) => [name, String(count)]));
}

function progressMetadata(report: ShippingProgress): Record<string, string> {
  return {
    kind: report.kind,
    ...countFields([
      ["bytes_written", report.bytesWritten],
      ["bytes_delivered", report.bytesDelivered],
      ["pending_window_count", report.pendingWindowCount],
      ["oldest_pending_window_age_ms", report.oldestPendingWindowAgeMs],
    ]),
  };
}

function saveMetadata(report: OffsetSaveStatus): Record<string, string> {
  return {
    kind: report.kind,
    error_class: report.errorClass,
    failure_count: String(report.failureCount),
  };
}

function metadataFor(report: BoxLogShipReport): Record<string, string> {
  return report.kind === "progress" ? progressMetadata(report) : saveMetadata(report);
}

function severityFor(report: BoxLogShipReport): "info" | "warn" {
  return report.kind === "save_failed" ? "warn" : "info";
}

export function boxLogShipTelemetry(report: BoxLogShipReport) {
  return {
    level: severityFor(report),
    message: BOX_LOG_SHIP_EVENT,
    metadata: metadataFor(report),
  };
}
