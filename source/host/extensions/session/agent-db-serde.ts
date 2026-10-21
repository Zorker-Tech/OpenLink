/**
 * How an agent's records are stored and read back.
 *
 * What a record may say is bounded to the values the platform knows — the sources a turn came from, the shape of an
 * empty profile, the shape of unread state — and what is read is normalized against those, so a record written by an
 * older version is read as what it meant then.
 */

/** The sources a request may say it came from; anything else is read as a request that did not say. */
export const REQUEST_SOURCES = new Set(["turn", "automation", "notification", "connector", "event", "handoff-resume", "background-revival", "web-search", "web-fetch"] as const);

export const EMPTY_SLATE_PROFILE = { description: "", avatarPath: null } as const;
export const EMPTY_UNREAD_STATE = { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 } as const;
export const EMPTY_SPEND_GUARD_STATE = { nudgedAtMs: null, snoozedUntilMs: null, optedOut: false, cardEntryIds: [], pausedAutomationIds: [] } as const;

export const REQUEST_ID_HISTORY_MAX = 200;
export const REQUEST_ID_PROMPT_MAX = 200;
export const EPISODE_TURN_TEXT_CAP = 2_000;
export const EPISODE_PENDING_MAX = 64;

type JsonObject = Record<string, unknown>;

/** A record is a plain object: an array or a primitive is not one, however it was written. */
function object(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** Stored text read as JSON, or nothing when it is missing or was never JSON. */
function parse(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** A number the platform can use, and the fallback for anything else it may find in a stored record. */
function finiteOr(candidate: unknown, fallback: number): number {
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
}

/** A time that was actually recorded: only a positive number is one, and nothing else counts as zero. */
function positiveOrNull(candidate: unknown): number | null {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

/** The ids a stored list holds, in order: anything that is not a non-empty text is not an id. */
function nonEmptyTexts(candidate: unknown): string[] {
  return Array.isArray(candidate) ? candidate.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** One of a stored list's entries that is a record, walked over one at a time. */
function eachObject(raw: string | null): JsonObject[] {
  const value = parse(raw);
  if (!Array.isArray(value)) return [];
  const records: JsonObject[] = [];
  for (const item of value) {
    const record = object(item);
    if (record != null) records.push(record);
  }
  return records;
}

/** What a transcript entry must say to be used, by the kind it says it is. */
const ENTRY_VALIDATORS: Readonly<Record<string, (entry: JsonObject) => boolean>> = {
  "send-message": (entry) => {
    const message = object(entry["message"]);
    return message != null && (message["type"] !== "text" || typeof message["content"] === "string");
  },
  message: (entry) => typeof entry["content"] === "string",
  "user-attachment": (entry) => typeof entry["file_path"] === "string",
  "tool-call": (entry) => typeof entry["name"] === "string",
  notice: (entry) => typeof entry["text"] === "string",
  event: (entry) => typeof object(entry["event"])?.["type"] === "string",
};

export function isValidTranscriptEntry(entry: unknown): entry is JsonObject {
  const value = object(entry);
  if (value == null) return false;
  const validator = ENTRY_VALIDATORS[String(value["kind"])];
  return validator !== undefined && validator(value);
}

/**
 * A transcript entry read back, or nothing when it is not one this build can use.
 *
 * An entry that says its kind is "error" needs no check of its own: it is not one of the kinds above, so the lookup
 * refuses it like any other kind this build does not know.
 */
export function parseTranscriptEntry(raw: string): JsonObject | null {
  const entry = parse(raw);
  return isValidTranscriptEntry(entry) ? entry : null;
}

/** The profile a record holds, with an unnamed avatar read as no avatar. */
export function parseProfile(raw: string | null): { description: string; avatarPath: string | null } {
  const value = object(parse(raw));
  if (value == null) return { ...EMPTY_SLATE_PROFILE };
  const avatarPath = value["avatarPath"];
  return {
    description: typeof value["description"] === "string" ? value["description"] : "",
    avatarPath: typeof avatarPath === "string" && avatarPath.length > 0 ? avatarPath : null,
  };
}

/** What has been read, and when: a count is whole and never negative, and the rest is a number or nothing. */
export function parseUnreadState(raw: string | null): { lastActivityAt: number; lastViewedAt: number; isManuallyUnread: boolean; unreadCount: number } {
  const value = object(parse(raw));
  if (value == null) return { ...EMPTY_UNREAD_STATE };
  const unread = finiteOr(value["unreadCount"], 0);
  return {
    lastActivityAt: finiteOr(value["lastActivityAt"], 0),
    lastViewedAt: finiteOr(value["lastViewedAt"], 0),
    isManuallyUnread: value["isManuallyUnread"] === true,
    unreadCount: unread > 0 ? Math.floor(unread) : 0,
  };
}

export interface SpendGuardState {
  nudgedAtMs: number | null;
  snoozedUntilMs: number | null;
  optedOut: boolean;
  cardEntryIds: string[];
  pausedAutomationIds: string[];
}

/** A guard state with nothing in it: the two lists are the caller's own, never the shared empty constant. */
function emptySpendGuard(nudgedAtMs: number | null = null): SpendGuardState {
  return { ...EMPTY_SPEND_GUARD_STATE, cardEntryIds: [], pausedAutomationIds: [], nudgedAtMs };
}

/**
 * The spend guard a record holds.
 *
 * A record written before the guard had a state of its own carries only the moment it nudged, so that is read as a guard
 * that was nudged and nothing else.
 */
export function resolveSpendGuardState(raw: { state: string | null; legacyNudgedAt?: unknown }): SpendGuardState {
  if (raw.state == null) {
    const legacy = Number(raw.legacyNudgedAt);
    return Number.isFinite(legacy) && legacy > 0 ? emptySpendGuard(legacy) : emptySpendGuard();
  }
  const value = object(parse(raw.state));
  if (value == null) return emptySpendGuard();
  return {
    nudgedAtMs: positiveOrNull(value["nudgedAtMs"]),
    snoozedUntilMs: positiveOrNull(value["snoozedUntilMs"]),
    optedOut: value["optedOut"] === true,
    cardEntryIds: nonEmptyTexts(value["cardEntryIds"]),
    pausedAutomationIds: nonEmptyTexts(value["pausedAutomationIds"]),
  };
}

/** Whether the guard has nothing to remember, in which case a record does not carry it at all. */
function isEmptySpendGuard(state: SpendGuardState): boolean {
  return state.nudgedAtMs == null && state.snoozedUntilMs == null && !state.optedOut && state.cardEntryIds.length === 0 && state.pausedAutomationIds.length === 0;
}

export function serializeSpendGuardState(state: SpendGuardState): string | null {
  return isEmptySpendGuard(state) ? null : JSON.stringify(state);
}

/** The tab a session is waiting on, or nothing when no tab is named. */
export function parseAwaitingState(raw: string | null): { tabId: string; reason: string; since: number } | null {
  const value = object(parse(raw));
  if (value == null) return null;
  const tabId = typeof value["tabId"] === "string" ? value["tabId"] : "";
  if (!tabId) return null;
  return {
    tabId,
    reason: typeof value["reason"] === "string" ? value["reason"] : "",
    since: finiteOr(value["since"], 0),
  };
}

export interface RequestRecord {
  id: string;
  at: number;
  prompt?: string;
  source?: string;
}

/** The requests an agent has been asked, oldest first: a record with no id is not one of them. */
export function parseRequestRecords(raw: string | null): RequestRecord[] {
  const records: RequestRecord[] = [];
  for (const entry of eachObject(raw)) {
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    if (!id) continue;
    const prompt = typeof entry["prompt"] === "string" && entry["prompt"].length > 0 ? entry["prompt"] : undefined;
    const source = typeof entry["source"] === "string" && REQUEST_SOURCES.has(entry["source"] as never) ? entry["source"] : undefined;
    records.push({
      id,
      at: positiveOrNull(entry["at"]) ?? 0,
      ...(prompt == null ? {} : { prompt }),
      ...(source == null ? {} : { source }),
    });
  }
  return records;
}

/** The prompt snapshot a memory render was taken from, when the record carries both of its parts. */
export function parseMemoryPromptSnapshot(raw: string | null): { render: string; compactionEpoch: number } | null {
  const value = object(parse(raw));
  if (value == null) return null;
  const epoch = value["compactionEpoch"];
  if (typeof value["render"] !== "string" || typeof epoch !== "number" || !Number.isFinite(epoch)) return null;
  return { render: value["render"], compactionEpoch: epoch };
}

/** Turns an episode has collected but not yet written: one with neither side said is not a turn. */
export function parsePendingEpisodeTurns(raw: string | null): Array<{ ts: number; user: string; agent: string }> {
  const turns: Array<{ ts: number; user: string; agent: string }> = [];
  for (const entry of eachObject(raw)) {
    const user = typeof entry["user"] === "string" ? entry["user"] : "";
    const agent = typeof entry["agent"] === "string" ? entry["agent"] : "";
    if (!user && !agent) continue;
    turns.push({ ts: finiteOr(entry["ts"], 0), user, agent });
  }
  return turns;
}
