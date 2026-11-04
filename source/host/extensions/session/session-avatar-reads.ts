import { basename } from "node:path";
import { readAvatarBytesWithinDir, readAvatarWithinDir, resolveDerivedAvatarFilename } from "../../agents/agent-avatar.ts";
import { getSlateProfilePath, readLegacyProfileAvatarField, readSlateProfileFile } from "../../agents/agent-profile.ts";
import type { SessionAvatarHost, SessionProfileTextHost } from "./session-profile-contracts.ts";

const readAvatarIfPresent = (directory: string, path: string | null) => path == null
  ? Promise.resolve(null)
  : readAvatarWithinDir(directory, path);

const readBytesIfPresent = (directory: string, path: string | null) => path == null
  ? Promise.resolve(null)
  : readAvatarBytesWithinDir(directory, path);

export function getAgentProfileText(host: SessionProfileTextHost, agentId: string) {
  const profile = readSlateProfileFile(getSlateProfilePath(host.getAgentDir(agentId)));
  if (profile == null) return null;
  return {
    name: profile.name,
    description: profile.description,
    title: profile.title,
    avatarShape: profile.avatarShape,
    avatarColor: profile.avatarColor,
  };
}

export async function readLegacyStoredAvatar<T>(
  host: SessionAvatarHost,
  agentId: string,
  read: (directory: string, path: string | null) => Promise<T | null>,
): Promise<T | null> {
  if (!host.agentExists(agentId)) return null;
  const directory = host.getAgentDir(agentId);
  return await host.withAgentDb(agentId, async (db) => read(directory, db.getSlateProfile().avatarPath));
}

export async function getAgentAvatar(host: SessionAvatarHost, agentId: string) {
  const directory = host.getAgentDir(agentId);
  const legacyPath = readLegacyProfileAvatarField(getSlateProfilePath(directory));
  const derivedPath = resolveDerivedAvatarFilename(directory, legacyPath);
  const avatar = await readAvatarIfPresent(directory, derivedPath)
    ?? await readLegacyStoredAvatar(host, agentId, readAvatarIfPresent);
  return { version: avatar?.version ?? null, dataUrl: avatar?.dataUrl ?? null };
}

export async function getAgentAvatarPng(host: SessionAvatarHost, agentId: string): Promise<Uint8Array | null> {
  const directory = host.getAgentDir(agentId);
  const legacyPath = readLegacyProfileAvatarField(getSlateProfilePath(directory));
  const derivedPath = resolveDerivedAvatarFilename(directory, legacyPath);
  return await readBytesIfPresent(directory, derivedPath)
    ?? await readLegacyStoredAvatar(host, agentId, readBytesIfPresent);
}

export const avatarBasename = (path: string): string => basename(path);
