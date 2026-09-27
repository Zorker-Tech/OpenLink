/**
 * Where an agent's own files live.
 *
 * An agent is a directory under the platform's root named by a safe folder id, and a path handed in from outside is
 * resolved against that root before it is used — an id that is not one, or a path that would leave the directory, is
 * refused instead of resolved.
 */
import { homedir } from "node:os"; import { isAbsolute, join, relative, sep } from "node:path"; import { getSlateRootDir } from "../host-paths.ts"; import { isSafeFolderId } from "./folder-id.ts";
export class SlateInvalidAgentIdError extends Error {} export function getSlateAgentsRootDir(homeDir = homedir()): string { return join(getSlateRootDir(homeDir), "agents"); } export function assertValidSlateAgentId(agentId: string): void { if (!isSafeFolderId(agentId) || agentId !== agentId.trim()) throw new SlateInvalidAgentIdError(`Invalid Slate agent id: ${agentId}`); } export function resolveSlateAgentDir(agentId: string, homeDir = homedir()): string { assertValidSlateAgentId(agentId); const root = getSlateAgentsRootDir(homeDir); const target = join(root, agentId); const rel = relative(root, target); if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) throw new SlateInvalidAgentIdError(`Invalid Slate agent id: ${agentId}`); return target; }
