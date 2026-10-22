/**
 * What a process reports about its memory.
 *
 * The report is read from the process itself and from whatever the caller counted — how many agents are loaded, how
 * many transcript entries, and how many minutes of the last quarter hour were idle — and a report that does not match
 * the shape is not a report.
 */
export interface MemoryReport {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly loadedAgents?: number;
  readonly loadedTranscriptEntries?: number;
  readonly idleMinutesLast15m?: number;
}

/** A field as the report itself carries it, rather than as a getter or a prototype would answer. */
function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** A count is a whole number that is not negative; anything else is not a count. */
function isMetricCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The bytes a process is using: a number, and not a negative one. */
function isUsedBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The bytes a process may use: a number, and a positive one — a limit of nothing is not a limit. */
function isLimitBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * A memory report read from a value, or nothing when the value is not one.
 *
 * Only a plain object is a report: a class instance or an array may carry the same field names and still not be what
 * the process sent, so the prototype is checked before anything is read.
 */
export function parseMemoryReport(value: unknown): MemoryReport | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const usedBytes = ownDataValue(value, "usedBytes");
    const limitBytes = ownDataValue(value, "limitBytes");
    if (!isUsedBytes(usedBytes) || !isLimitBytes(limitBytes)) return null;
    const loadedAgents = ownDataValue(value, "loadedAgents");
    const loadedTranscriptEntries = ownDataValue(value, "loadedTranscriptEntries");
    const idleMinutesLast15m = ownDataValue(value, "idleMinutesLast15m");
    return {
      // `-0` is not a number anyone means: the report says zero.
      usedBytes: usedBytes === 0 ? 0 : usedBytes,
      limitBytes,
      ...(isMetricCount(loadedAgents) ? { loadedAgents } : {}),
      ...(isMetricCount(loadedTranscriptEntries) ? { loadedTranscriptEntries } : {}),
      ...(isMetricCount(idleMinutesLast15m) ? { idleMinutesLast15m } : {}),
    };
  } catch {
    return null;
  }
}
