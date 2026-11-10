/** Resolve filesystem paths owned by each agent. */
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { getSlateRootDir } from "../host-paths.ts"
import { isSafeFolderId } from "./folder-id.ts"

export class SlateInvalidAgentIdError extends Error {}

function rejectInvalidIdentifier(agentId: string): never {
  throw new SlateInvalidAgentIdError(`Invalid Slate agent id: ${agentId}`)
}

function isValidAgentDirectoryName(agentId: string): boolean {
  return isSafeFolderId(agentId) && agentId === agentId.trim()
}

export function getSlateAgentsRootDir(homeDirectory = homedir()): string {
  return join(getSlateRootDir(homeDirectory), "agents")
}

export function assertValidSlateAgentId(agentId: string): void {
  if (!isValidAgentDirectoryName(agentId)) rejectInvalidIdentifier(agentId)
}

function assertIsChildDirectory(root: string, candidate: string, agentId: string): void {
  const relativePath = relative(root, candidate)
  const escapesRoot = relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
  if (relativePath.length === 0 || escapesRoot || relativePath.includes(sep)) rejectInvalidIdentifier(agentId)
}

export function resolveSlateAgentDir(agentId: string, homeDirectory = homedir()): string {
  assertValidSlateAgentId(agentId)
  const root = getSlateAgentsRootDir(homeDirectory)
  const candidate = join(root, agentId)
  assertIsChildDirectory(root, candidate, agentId)
  return candidate
}
