/** Disk pressure as the telemetry backend reports it: the level, the volume it was measured on and how much room is left. */
export type DiskPressureLevel = "hard" | "soft" | string;

export interface DiskPressureReading {
  level: DiskPressureLevel;
  volume: string;
  trigger: string;
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
}

/**
 * The backend's own word for each pressure this build raises; anything else is told as information.
 *
 * A map, not an object: a level arrives from outside, and a name every object already has must not answer as a severity.
 */
const TELEMETRY_LEVELS: ReadonlyMap<string, "error" | "warn"> = new Map<string, "error" | "warn">([
  ["hard", "error"],
  ["soft", "warn"],
]);

/** How a pressure level is reported: the two this build raises, and anything a newer version might. */
export function severityOf(level: DiskPressureLevel): "error" | "warn" | "info" {
  return TELEMETRY_LEVELS.get(level) ?? "info";
}

/**
 * One disk pressure, as the telemetry backend is told about it.
 *
 * The numbers are sent as text because the backend reads them that way, and the percentage is kept to one decimal: it
 * is read by a person looking at a dashboard, not compared.
 */
export function diskPressureReport(report: DiskPressureReading) {
  return {
    level: severityOf(report.level),
    metadata: {
      volume: report.volume,
      pressure_level: report.level,
      trigger: report.trigger,
      total_bytes: String(report.totalBytes),
      available_bytes: String(report.availableBytes),
      used_percent: report.usedPercent.toFixed(1),
    },
  };
}
