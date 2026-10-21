/**
 * The asynchronous tasks a transcript shows.
 *
 * What the ledger of pending wakes knows and what the live work knows are unioned into one list, and a task that is
 * only in the ledger says so, so the reader is not told about work that is not running any more.
 */
export const LEDGER_ONLY_DETAIL = "from the durable pending-wake ledger";
export type PendingWakeKind = "cloud-agent" | "shell" | "subagent";
export interface PendingWakeMarker {
  agentId: string;
  kind: PendingWakeKind;
  workId: string;
  markedAtMs: number;
  title?: string;
  subagentType?: string;
}
export interface AsyncTask {
  kind: string;
  id: string;
  label: string;
  status: string;
  startedAtMs: number;
  detail?: string;
}
/** What a task is called, by the kind of work it is, when it brought no title of its own. */
const KIND_LABELS: Readonly<Record<PendingWakeKind, string>> = {
  "cloud-agent": "Cloud agent",
  shell: "Background command",
  subagent: "Background task",
};

/** The title a marker brought, when it brought one. */
function ownTitle(marker: PendingWakeMarker): string | undefined {
  return marker.title != null && marker.title.length > 0 ? marker.title : undefined;
}

export function markerLabel(marker: PendingWakeMarker): string {
  return ownTitle(marker) ?? `${KIND_LABELS[marker.kind]} ${marker.workId}`;
}

/** What a reader is told about a task the ledger knows and the live work does not. */
function ledgerDetail(marker: PendingWakeMarker): string {
  return marker.subagentType != null && marker.subagentType.length > 0
    ? `${marker.subagentType} · ${LEDGER_ONLY_DETAIL}`
    : LEDGER_ONLY_DETAIL;
}

/** A marker read as the task a transcript shows: the work is running, though only the ledger knows it. */
export function pendingWakeMarkerToAsyncTask(marker: PendingWakeMarker): AsyncTask {
  return {
    kind: marker.kind,
    id: marker.workId,
    label: markerLabel(marker),
    status: "running",
    startedAtMs: marker.markedAtMs,
    detail: ledgerDetail(marker),
  };
}

/** What tells two tasks apart: a task id is only an id within its own kind. */
function identityOf(task: { readonly kind: string; readonly id: string }): string {
  return `${task.kind}\u0000${task.id}`;
}

/**
 * The tasks a transcript shows: the ones the live work knows, and the ones only the ledger knows — each once, ordered by
 * when they started and then by id, so two tasks that started together keep a stable order.
 */
export function mergeAsyncTasks(liveTasks: readonly AsyncTask[], markers: readonly PendingWakeMarker[]): AsyncTask[] {
  const known = new Set(liveTasks.map(identityOf));
  const merged = [...liveTasks];
  for (const marker of markers) {
    const identity = identityOf({ kind: marker.kind, id: marker.workId });
    if (known.has(identity)) continue;
    known.add(identity);
    merged.push(pendingWakeMarkerToAsyncTask(marker));
  }
  return merged.sort((left, right) => left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id));
}
