/** What the host still owes an agent when it comes back.

 * A wake that was marked but never delivered is written down — which agent, which kind of work, which work — so the
 * host can deliver it again after a restart; what was delivered, or grew too old to matter, is forgotten. */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SLATE_PENDING_WAKE_FILE_NAME } from "../durable-file-policy.ts";
import type { PendingWakeKind, PendingWakeMarker } from "./async-task-union.ts";
export const PENDING_WAKE_KINDS = ["cloud-agent", "subagent", "shell"] as const;
export interface QuietWakeOrigin {
  automation?: { id: string; name: string };
}
export interface DurablePendingWakeMarker extends PendingWakeMarker {
  quietOrigin?: QuietWakeOrigin;
  interruptedByRecreate?: boolean;
}
export function coerceQuietOrigin(
  rawOrigin: unknown,
): DurablePendingWakeMarker["quietOrigin"] | null {
  if (typeof rawOrigin !== "object" || rawOrigin == null) return null;
  const automationValue = (rawOrigin as { automation?: unknown }).automation;
  if (typeof automationValue !== "object" || automationValue == null) return {};
  const a = automationValue as Record<string, unknown>;
  return typeof a.id === "string" &&
    a.id.length > 0 &&
    typeof a.name === "string"
    ? { automation: { id: a.id, name: a.name } }
    : {};
}
export function coerceMarker(markerCandidate: unknown): DurablePendingWakeMarker | null {
  if (typeof markerCandidate !== "object" || markerCandidate == null) return null;
  const markerFields = markerCandidate as Record<string, unknown>;
  if (
    typeof markerFields.agentId !== "string" ||
    !markerFields.agentId ||
    typeof markerFields.workId !== "string" ||
    !markerFields.workId ||
    !PENDING_WAKE_KINDS.includes(markerFields.kind as PendingWakeKind)
  )
    return null;
  const quietOrigin = coerceQuietOrigin(markerFields.quietOrigin);
  return {
    agentId: markerFields.agentId,
    kind: markerFields.kind as PendingWakeKind,
    workId: markerFields.workId,
    markedAtMs:
      typeof markerFields.markedAtMs === "number" && Number.isFinite(markerFields.markedAtMs)
        ? markerFields.markedAtMs
        : 0,
    ...(quietOrigin != null ? { quietOrigin } : {}),
    ...(typeof markerFields.title === "string" && markerFields.title.length > 0
      ? { title: markerFields.title }
      : {}),
    ...(typeof markerFields.subagentType === "string" && markerFields.subagentType.length > 0
      ? { subagentType: markerFields.subagentType }
      : {}),
    ...(markerFields.interruptedByRecreate === true
      ? { interruptedByRecreate: true }
      : {}),
  };
}
export function coercePendingWakeMarkers(
  rawOrigin: unknown,
): DurablePendingWakeMarker[] {
  return Array.isArray(rawOrigin)
    ? rawOrigin.flatMap((markerCandidate) => {
        const marker = coerceMarker(markerCandidate);
        return marker == null ? [] : [marker];
      })
    : [];
}
export function parsePendingWakeFile(
  fileText: string | null,
): DurablePendingWakeMarker[] {
  if (fileText == null) return [];
  try {
    const rawOrigin = JSON.parse(fileText) as { pending?: unknown };
    return typeof rawOrigin === "object" && rawOrigin != null
      ? coercePendingWakeMarkers(rawOrigin.pending)
      : [];
  } catch {
    return [];
  }
}
export function markerKeyMatches(
  marker: DurablePendingWakeMarker,
  agentId: string,
  kind: PendingWakeKind,
  workId: string,
): boolean {
  return (
    marker.agentId === agentId &&
    marker.kind === kind &&
    marker.workId === workId
  );
}
export function upsertPendingWakeMarker(
  currentMarkers: readonly DurablePendingWakeMarker[],
  marker: DurablePendingWakeMarker,
): DurablePendingWakeMarker[] {
  return [
    ...currentMarkers.filter(
      (markerCandidate) =>
        !markerKeyMatches(markerCandidate, marker.agentId, marker.kind, marker.workId),
    ),
    marker,
  ];
}
export class SlatePendingWakeStore {
  readonly filePath: string;
  constructor(rootDirectory: string) {
    this.filePath = join(rootDirectory, SLATE_PENDING_WAKE_FILE_NAME);
  }
  markPending(marker: DurablePendingWakeMarker): boolean {
    try {
      this.write(upsertPendingWakeMarker(this.readPending(), marker));
      return true;
    } catch {
      return false;
    }
  }
  listPending(): DurablePendingWakeMarker[] {
    return this.readPending();
  }
  hasPending(agentId: string, kind: PendingWakeKind, workId: string): boolean {
    return this.readPending().some((markerCandidate) =>
      markerKeyMatches(markerCandidate, agentId, kind, workId),
    );
  }
  clearOne(agentId: string, kind: PendingWakeKind, workId: string): boolean {
    try {
      const currentMarkers = this.readPending(),
        keptMarkers = currentMarkers.filter(
          (markerCandidate) => !markerKeyMatches(markerCandidate, agentId, kind, workId),
        );
      if (keptMarkers.length === currentMarkers.length) return false;
      keptMarkers.length === 0 ? this.deleteFile() : this.write(keptMarkers);
      return true;
    } catch {
      return false;
    }
  }
  clearAgent(agentId: string): void {
    try {
      const currentMarkers = this.readPending(),
        keptMarkers = currentMarkers.filter((markerCandidate) => markerCandidate.agentId !== agentId);
      if (keptMarkers.length === currentMarkers.length) return;
      keptMarkers.length === 0 ? this.deleteFile() : this.write(keptMarkers);
    } catch {}
  }
  clearAll(): void {
    this.deleteFile();
  }
  pruneStale(maxAge: number, now = Date.now()): DurablePendingWakeMarker[] {
    try {
      const currentMarkers = this.readPending(),
        staleMarkers = currentMarkers.filter(
          (markerCandidate) => now - markerCandidate.markedAtMs > maxAge,
        );
      if (staleMarkers.length === 0) return [];
      const keptMarkers = currentMarkers.filter(
        (markerCandidate) => now - markerCandidate.markedAtMs <= maxAge,
      );
      keptMarkers.length === 0 ? this.deleteFile() : this.write(keptMarkers);
      return staleMarkers;
    } catch {
      return [];
    }
  }
  readPending(): DurablePendingWakeMarker[] {
    try {
      return parsePendingWakeFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return [];
    }
  }
  write(pending: readonly DurablePendingWakeMarker[]): void {
    const temporaryPath = `${this.filePath}.part`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {}
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, pending }));
    renameSync(temporaryPath, this.filePath);
  }
  deleteFile(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {}
  }
}
