/**
 * The group an agent belongs to.
 *
 * A group is kept beside the agent as one file: the local members, the ones who live elsewhere, and the room it shares.
 * What is read is normalized — ids trimmed and de-duplicated, remote members keyed by owner and agent, both lists
 * bounded — and a file that says nothing at all is no group rather than an empty one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SLATE_GROUP_FILENAME = "group.json";
export const GROUP_CONFIG_VERSION = 1;
export const GROUP_MAX_MEMBERS = 6;

export interface RemoteGroupMember { ownerAuthId: string; agentId: string; name: string; avatarDataUrl?: string }
export interface SlateGroupConfig { version: number; memberIds: string[]; remoteMembers?: RemoteGroupMember[]; sharedRoomId?: string }

/** The file a group is kept in, beside its agent. */
export function getSlateGroupPath(agentDir: string): string {
  return join(agentDir, SLATE_GROUP_FILENAME);
}

/** A text that says something after trimming, or nothing when the value is another type or blank. */
function trimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** A record a stored member may be read from: an object, and not an array. */
function isMemberRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** A remote member's identity, which is what de-duplicates it. */
function remoteMemberKey(ownerAuthId: string, agentId: string): string {
  return `${ownerAuthId}\0${agentId}`;
}

export function normalizeMemberIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = trimmedText(value);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= GROUP_MAX_MEMBERS) break;
  }
  return [...seen];
}

/** The remote member a stored value names, or nothing when the value does not name one. */
function remoteMemberOf(value: unknown): RemoteGroupMember | undefined {
  if (!isMemberRecord(value)) return undefined;
  const ownerAuthId = trimmedText(value.ownerAuthId);
  const agentId = trimmedText(value.agentId);
  if (ownerAuthId === undefined || agentId === undefined) return undefined;
  const name = trimmedText(value.name);
  const avatarDataUrl = typeof value.avatarDataUrl === "string" && value.avatarDataUrl !== "" ? value.avatarDataUrl : undefined;
  return { ownerAuthId, agentId, name: name ?? "Agent", ...(avatarDataUrl === undefined ? {} : { avatarDataUrl }) };
}

export function normalizeRemoteMembers(raw: unknown): RemoteGroupMember[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const members: RemoteGroupMember[] = [];
  for (const value of raw) {
    const member = remoteMemberOf(value);
    if (member === undefined) continue;
    const key = remoteMemberKey(member.ownerAuthId, member.agentId);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(member);
    if (members.length >= GROUP_MAX_MEMBERS) break;
  }
  return members;
}

/** The text a shared room is named by, or nothing when the field is absent or blank. */
function sharedRoomIdOf(record: Record<string, unknown>): string | undefined {
  const roomId = record.sharedRoomId;
  return typeof roomId === "string" && roomId.length > 0 ? roomId : undefined;
}

export function readSlateGroupConfig(agentDir: string): SlateGroupConfig | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(getSlateGroupPath(agentDir), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  const memberIds = normalizeMemberIds(parsed.memberIds);
  const remoteMembers = normalizeRemoteMembers(parsed.remoteMembers);
  const sharedRoomId = sharedRoomIdOf(parsed);
  if (memberIds.length === 0 && remoteMembers.length === 0 && sharedRoomId === undefined) return null;
  return {
    version: typeof parsed.version === "number" ? parsed.version : GROUP_CONFIG_VERSION,
    memberIds,
    ...(remoteMembers.length > 0 ? { remoteMembers } : {}),
    ...(sharedRoomId === undefined ? {} : { sharedRoomId }),
  };
}

/** The group as its file keeps it: the same fields, normalized and with the empty ones left out. */
function groupFileRecord(config: SlateGroupConfig): Record<string, unknown> {
  const remoteMembers = normalizeRemoteMembers(config.remoteMembers);
  return {
    version: config.version,
    memberIds: normalizeMemberIds(config.memberIds),
    ...(remoteMembers.length > 0 ? { remoteMembers } : {}),
    ...(config.sharedRoomId ? { sharedRoomId: config.sharedRoomId } : {}),
  };
}

export function writeSlateGroupConfig(agentDir: string, config: SlateGroupConfig): void {
  const path = getSlateGroupPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(groupFileRecord(config), null, 2)}\n`, "utf8");
}

export function isSlateGroupDir(agentDir: string): boolean {
  return readSlateGroupConfig(agentDir) != null;
}
