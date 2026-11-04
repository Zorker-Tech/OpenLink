export const SKILL_PUBLISH_REQUEST_TIMEOUT_MS = 60_000
export const SKILL_PUBLISH_TARGETS_TIMEOUT_MS = 10_000
export const PUBLISHED_SKILL_CONFIRM_ATTEMPTS = 5

export interface SkillPublishTeam {
  readonly id: number
  readonly isDirectMember: boolean
  readonly name: string
}

export interface SkillPublishPayload {
  readonly teamId: number
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly pluginArchive: Uint8Array
}

export interface UnpublishSkillRequest {
  readonly pluginId: string
  readonly teamId: number
}

export interface PublishedSkillResult {
  readonly pluginId: string
  readonly commitSha: string
}

export interface SkillPublishClient {
  getTeams(): Promise<{ readonly teams: readonly SkillPublishTeam[] }>
  publishPlugin(request: SkillPublishPayload): Promise<PublishedSkillResult>
  unpublishPlugin(request: UnpublishSkillRequest): Promise<unknown>
}
