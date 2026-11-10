export interface AckObligation {
  agentId: string;
  createdAtMs: number;
  lastSendAtMs: number;
  lastInterruptAtMs?: number;
  coalescedCount: number;
  redriveAttempts: number;
}

export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function coerceObligation(value: unknown): AckObligation | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.agentId !== "string" || record.agentId.length === 0) return null;

  const createdAtMs = finiteNumber(record.createdAtMs, 0);
  const lastSendAtMs = finiteNumber(record.lastSendAtMs, createdAtMs);
  const lastInterruptAtMs = finiteNumber(record.lastInterruptAtMs, Number.NaN);
  return {
    agentId: record.agentId,
    createdAtMs,
    lastSendAtMs,
    ...(Number.isFinite(lastInterruptAtMs) ? { lastInterruptAtMs } : {}),
    coalescedCount: Math.max(1, finiteNumber(record.coalescedCount, 1)),
    redriveAttempts: Math.max(0, finiteNumber(record.redriveAttempts, 0)),
  };
}

export function parseAckObligationsFile(raw: string | null): AckObligation[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { pending?: unknown }).pending)) return [];
    return ((parsed as { pending: unknown[] }).pending).flatMap((entry) => {
      const obligation = coerceObligation(entry);
      return obligation === null ? [] : [obligation];
    });
  } catch {
    return [];
  }
}
