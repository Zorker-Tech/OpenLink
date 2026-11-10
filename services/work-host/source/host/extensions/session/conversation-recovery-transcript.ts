import { REBUILT_ENTRY_ID_PREFIX, type OutlineItem } from "./conversation-recovery-contracts.ts";

type TranscriptRecoveryState = {
  readonly turns: readonly { readonly items: readonly OutlineItem[] }[];
};

/** Rebuild visible transcript entries and assign ids reserved for recovered data. */
export function rebuildTranscriptEntriesFromState(state: TranscriptRecoveryState): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const turn of state.turns) {
    for (const item of turn.items) {
      const entry = recoveredEntry(item);
      if (entry != null) entries.push(entry);
    }
  }
  return entries;
}

function recoveredEntry(item: OutlineItem): Record<string, unknown> | null {
  if (item.kind === "user") {
    if (item.hidden) return null;
    return {
      kind: "message",
      id: `${REBUILT_ENTRY_ID_PREFIX}${item.id}`,
      role: "user",
      content: item.text ?? "",
      isStreaming: false,
      ...(item.timestampMs == null ? {} : { timestampMs: item.timestampMs }),
    };
  }

  if (item.kind === "send-message") {
    return {
      kind: "send-message",
      id: `${REBUILT_ENTRY_ID_PREFIX}${item.id}`,
      message: item.message,
      ...(item.timestampMs == null ? {} : { timestampMs: item.timestampMs }),
    };
  }

  return {
    kind: "tool-call",
    id: `${REBUILT_ENTRY_ID_PREFIX}${item.id}`,
    name: item.name,
    status: item.status,
    ...(item.summary == null ? {} : { summary: item.summary }),
    ...(item.timestampMs == null ? {} : { timestampMs: item.timestampMs }),
  };
}

/** Delete only recovered hidden user entries whose content still agrees with the outline. */
export function selectHiddenArtifactEntryIds(
  entries: readonly Record<string, unknown>[],
  outline: readonly OutlineItem[],
): string[] {
  const outlineById = new Map(outline.map((item) => [item.id, item]));
  return entries.flatMap((entry) => {
    if (entry.kind !== "message" || entry.role !== "user" || typeof entry.id !== "string") return [];
    if (!entry.id.startsWith(REBUILT_ENTRY_ID_PREFIX)) return [];
    const sourceId = entry.id.slice(REBUILT_ENTRY_ID_PREFIX.length);
    const source = outlineById.get(sourceId);
    return source?.kind === "user" && source.hidden === true && source.text === entry.content ? [entry.id] : [];
  });
}
