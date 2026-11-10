/**
 * An agent's profile: what it is called and what it is for.
 *
 * The profile is one file beside the agent, written atomically, and what is read is normalized — a name that says
 * nothing is dropped, and the padding around a title is — so an agent is never described by half a record.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SLATE_PROFILE_FILENAME = "profile.json";

export interface SlateAgentProfile {
  name: string;
  description: string;
  title: string;
  avatarShape: string;
  avatarColor: string;
}

/** The fields every profile has, in the order a file is written with them. */
const PROFILE_FIELDS = ["name", "description", "title", "avatarShape", "avatarColor"] as const;

export function getSlateProfilePath(agentDir: string): string {
  return join(agentDir, SLATE_PROFILE_FILENAME);
}

/** The record a profile file holds, or nothing when it is missing, unreadable or not a record. */
function readProfileRecord(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A field as the text a profile keeps: whatever was not a text is empty, and the padding is not part of it. */
function textField(record: Record<string, unknown>, field: (typeof PROFILE_FIELDS)[number]): string {
  const value = record[field];
  return typeof value === "string" ? value.trim() : "";
}

export function readSlateProfileFile(path: string): SlateAgentProfile | null {
  const record = readProfileRecord(path);
  if (record === null) return null;
  return {
    name: textField(record, "name"),
    description: textField(record, "description"),
    title: textField(record, "title"),
    avatarShape: textField(record, "avatarShape"),
    avatarColor: textField(record, "avatarColor"),
  };
}

/** The avatar a profile was written with before the shape and colour were separate fields. */
export function readLegacyProfileAvatarField(path: string): string | null {
  const avatar = readProfileRecord(path)?.["avatar"];
  if (typeof avatar !== "string") return null;
  const trimmed = avatar.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Writes the profile beside the agent, atomically: the new content lands in a file of its own and is renamed over the
 * old one, so a reader never sees half a profile.
 */
export function writeSlateProfileFile(path: string, profile: SlateAgentProfile): void {
  mkdirSync(dirname(path), { recursive: true });
  const written = { ...profile, title: profile.title.trim(), avatarShape: profile.avatarShape.trim(), avatarColor: profile.avatarColor.trim() };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(written, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
