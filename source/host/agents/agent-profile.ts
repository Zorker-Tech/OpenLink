/**
 * An agent's profile: what it is called and what it is for.
 *
 * The profile is one file beside the agent, written atomically, and what is read is normalized — a name that says
 * nothing is dropped, and the description is bounded — so an agent is never described by half a record.
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

export function getSlateProfilePath(agentDir: string): string { return join(agentDir, SLATE_PROFILE_FILENAME); }

function parseProfileJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function readSlateProfileFile(path: string): SlateAgentProfile | null {
  const parsed = parseProfileJson(path);
  if (parsed == null) return null;
  return {
    name: typeof parsed.name === "string" ? parsed.name : "",
    description: typeof parsed.description === "string" ? parsed.description : "",
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    avatarShape: typeof parsed.avatarShape === "string" ? parsed.avatarShape.trim() : "",
    avatarColor: typeof parsed.avatarColor === "string" ? parsed.avatarColor.trim() : ""
  };
}

export function readLegacyProfileAvatarField(path: string): string | null {
  const avatar = parseProfileJson(path)?.avatar;
  if (typeof avatar !== "string") return null;
  const trimmed = avatar.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function writeSlateProfileFile(path: string, profile: SlateAgentProfile): void {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify({ ...profile, title: profile.title.trim(), avatarShape: profile.avatarShape.trim(), avatarColor: profile.avatarColor.trim() }, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, serialized, "utf8");
  renameSync(temporary, path);
}
