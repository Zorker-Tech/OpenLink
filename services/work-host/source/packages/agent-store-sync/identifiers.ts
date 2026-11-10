const BARE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORE_ID_PATTERN =
  /^store-[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHARE_MOUNT_KEY_PATTERN = /^store-[A-Za-z0-9_-]{24}$/
const CLOUD_SOURCE_ID_PATTERN =
  /^bc-(?:[0-9a-z][0-9a-z-]*-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const USER_SOURCE_ID_PATTERN = /^(?:t([1-9][0-9]*)-)?u([1-9][0-9]*)$/
const TEAM_SOURCE_ID_PATTERN = /^t([1-9][0-9]*)$/

export interface AgentStoreUserSource {
  readonly userId: number
  readonly teamId?: number
}

function positiveSafeId(value: string): number | undefined {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

export function parseUserAgentStoreSourceId(
  sourceId: string,
): AgentStoreUserSource | undefined {
  const match = USER_SOURCE_ID_PATTERN.exec(sourceId)
  const rawUserId = match?.[2]
  if (rawUserId === undefined) return undefined
  const userId = positiveSafeId(rawUserId)
  const rawTeamId = match?.[1]
  const teamId = rawTeamId === undefined ? undefined : positiveSafeId(rawTeamId)
  if (userId === undefined || (rawTeamId !== undefined && teamId === undefined)) {
    return undefined
  }
  return teamId === undefined ? { userId } : { userId, teamId }
}

export function parseTeamAgentStoreSourceId(
  sourceId: string,
): { readonly teamId: number } | undefined {
  const rawTeamId = TEAM_SOURCE_ID_PATTERN.exec(sourceId)?.[1]
  if (rawTeamId === undefined) return undefined
  const teamId = positiveSafeId(rawTeamId)
  return teamId === undefined ? undefined : { teamId }
}

export function isValidBareUuid(value: string): boolean {
  return BARE_UUID_PATTERN.test(value)
}

export function isCloudAgentStoreId(value: string): boolean {
  return CLOUD_SOURCE_ID_PATTERN.test(value)
}

export function isAgentStoreId(value: string): boolean {
  return STORE_ID_PATTERN.test(value)
}

export function isAgentStoreSourceId(sourceId: string): boolean {
  return isCloudAgentStoreId(sourceId) || isValidBareUuid(sourceId)
}

export function isAgentStoreShareMountKey(value: string): boolean {
  return SHARE_MOUNT_KEY_PATTERN.test(value)
}
