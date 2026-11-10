/**
 * The room an agent shares with somebody else.
 *
 * A shared room is kept beside the agent as one file: who hosts it, who is in it, and whether it was revoked. What is
 * read is read defensively — a member that names nobody is dropped, a name that says nothing is replaced, and the list
 * is bounded — so a file that was edited by hand cannot make the room unbounded or unnamed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file a shared room is kept in, beside the agent. */
export const SLATE_REMOTE_ROOM_FILENAME = "remote-room.json";

/** The version this code writes when the file does not name one. */
export const REMOTE_ROOM_CONFIG_VERSION = 1;

/** The most members a shared room may have, however many the file lists. */
const MAX_REMOTE_ROOM_MEMBERS = 24;

/** The name a member is shown under when the file names none. */
const ANONYMOUS_MEMBER_NAME = "Someone";

/** The name the host is shown under when the file names none. */
const DEFAULT_HOST_NAME = "The host";

/** The newline every written file ends with. */
const FILE_TRAILING_NEWLINE = "\n";

/** One member of the room. */
export interface RemoteRoomMember { kind: "agent" | "human"; authId: string; agentId: string; displayName: string; avatarUrl?: string }

/** The room as the file keeps it. */
export interface SlateRemoteRoomConfig { version: number; roomId: string; hostAuthId: string; hostName: string; hostAvatarUrl?: string; members: RemoteRoomMember[]; isRevoked?: true }

/** Where the room's file is kept for this agent. */
export function getSlateRemoteRoomPath(agentDir: string): string {
  return join(agentDir, SLATE_REMOTE_ROOM_FILENAME);
}

/** The text a record carries under this key, when it carries text there. */
function textOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** The text a record carries under this key, when it carries something there. */
function nonEmptyTextOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = textOf(record, key);
  return value ? value : undefined;
}

/** One member as the file describes it, when it describes one we can name. */
function memberFromValue(value: unknown): RemoteRoomMember | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const authId = nonEmptyTextOf(candidate, "authId");
  if (authId === undefined) return undefined;
  const avatarUrl = nonEmptyTextOf(candidate, "avatarUrl");
  return {
    kind: candidate.kind === "agent" ? "agent" : "human",
    authId,
    agentId: textOf(candidate, "agentId") ?? "",
    displayName: nonEmptyTextOf(candidate, "displayName") ?? ANONYMOUS_MEMBER_NAME,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  };
}

/** The members a file describes, dropping the ones that name nobody and keeping at most the bound. */
export function normalizeRemoteRoomMembers(raw: unknown): RemoteRoomMember[] {
  if (!Array.isArray(raw)) return [];
  const members: RemoteRoomMember[] = [];
  for (const value of raw) {
    const member = memberFromValue(value);
    if (member !== undefined) members.push(member);
    if (members.length >= MAX_REMOTE_ROOM_MEMBERS) break;
  }
  return members;
}

/** The room a parsed file describes, when it is a room at all. */
function configFromParsed(parsed: Record<string, unknown>): SlateRemoteRoomConfig | null {
  const roomId = nonEmptyTextOf(parsed, "roomId");
  const hostAuthId = nonEmptyTextOf(parsed, "hostAuthId");
  if (roomId === undefined || hostAuthId === undefined) return null;
  const hostAvatarUrl = nonEmptyTextOf(parsed, "hostAvatarUrl");
  return {
    version: typeof parsed.version === "number" ? parsed.version : REMOTE_ROOM_CONFIG_VERSION,
    roomId,
    hostAuthId,
    hostName: nonEmptyTextOf(parsed, "hostName") ?? DEFAULT_HOST_NAME,
    ...(hostAvatarUrl === undefined ? {} : { hostAvatarUrl }),
    members: normalizeRemoteRoomMembers(parsed.members),
    ...(parsed.isRevoked === true ? { isRevoked: true } : {}),
  };
}

/** The room beside this agent, or null when there is no room file or it describes no room. */
export function readSlateRemoteRoomConfig(agentDir: string): SlateRemoteRoomConfig | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(getSlateRemoteRoomPath(agentDir), "utf8"));
  } catch {
    return null;
  }
  return configFromParsed(parsed);
}

/** Keep the room beside this agent, as the file the reader understands. */
export function writeSlateRemoteRoomConfig(agentDir: string, config: SlateRemoteRoomConfig): void {
  const path = getSlateRemoteRoomPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}${FILE_TRAILING_NEWLINE}`, "utf8");
}

/** Whether this agent has a shared room. */
export function isSlateRemoteRoomDir(agentDir: string): boolean {
  return readSlateRemoteRoomConfig(agentDir) !== null;
}
