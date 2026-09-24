/**
 * Agent-store identities.
 *
 * A store is addressed by an id with a shape the backend also accepts, so the patterns here are a
 * contract rather than a convenience: an id that fails them is refused before it reaches a request.
 * Source ids additionally carry whose store it is — a user, optionally inside a team.
 */

const BARE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AGENT_STORE_ID_PATTERN = /^store-[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AGENT_STORE_SHARE_ID_PATTERN = /^store-[A-Za-z0-9_-]{24}$/
const CLOUD_AGENT_STORE_ID_PATTERN = /^bc-(?:[0-9a-z][0-9a-z-]*-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AGENT_STORE_USER_SOURCE_ID_PATTERN = /^(?:t([1-9][0-9]*)-)?u([1-9][0-9]*)$/
const AGENT_STORE_TEAM_SOURCE_ID_PATTERN = /^t([1-9][0-9]*)$/

/** Where a store is mounted inside an agent's workspace. */
export const AGENT_STORE_USER_MOUNT_NAME = "user"
export const AGENT_STORE_TEAM_MOUNT_NAME = "team"
export const AGENT_STORE_AUTOMATION_MOUNT_NAME = "automation"
export const NAMED_AGENT_HOME_STORE_MOUNT_NAME = "home"

/** Paths under a mount that belong to the platform, not to the user's files. */
export const AGENT_STORE_RESERVED_PATH_PREFIX = ".slate"

/** Read by the host to find the store's file directory when it is relocated. */
export const SLATE_AGENT_STORE_FILES_DIR_ENV = "SLATE_AGENT_STORE_FILES_DIR"

function parsePositiveSafeInteger(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export interface AgentStoreUserSource {
  readonly userId: number
  readonly teamId?: number
}

export function parseUserAgentStoreSourceId(sourceId: string): AgentStoreUserSource | undefined {
  const match = AGENT_STORE_USER_SOURCE_ID_PATTERN.exec(sourceId)
  if (match?.[2] === undefined) return undefined
  const userId = parsePositiveSafeInteger(match[2])
  const teamId = match[1] === undefined ? undefined : parsePositiveSafeInteger(match[1])
  if (userId === undefined || (match[1] !== undefined && teamId === undefined)) return undefined
  return teamId === undefined ? { userId } : { userId, teamId }
}

export function parseTeamAgentStoreSourceId(sourceId: string): { teamId: number } | undefined {
  const raw = AGENT_STORE_TEAM_SOURCE_ID_PATTERN.exec(sourceId)?.[1]
  if (raw === undefined) return undefined
  const teamId = parsePositiveSafeInteger(raw)
  return teamId === undefined ? undefined : { teamId }
}

export function isValidBareUuid(agentId: string): boolean {
  return BARE_UUID_PATTERN.test(agentId)
}

export function isCloudAgentStoreId(agentId: string): boolean {
  return CLOUD_AGENT_STORE_ID_PATTERN.test(agentId)
}

export function isAgentStoreId(storeId: string): boolean {
  return AGENT_STORE_ID_PATTERN.test(storeId)
}

/** Either form the backend hands out: a cloud store id or a bare uuid. */
export function isAgentStoreSourceId(sourceId: string): boolean {
  return isCloudAgentStoreId(sourceId) || isValidBareUuid(sourceId)
}

export function isAgentStoreShareMountKey(mountKey: string): boolean {
  return AGENT_STORE_SHARE_ID_PATTERN.test(mountKey)
}
