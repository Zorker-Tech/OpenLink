import { readManagedSkillsCache, writeManagedSkillsCache } from "./managed-skills-cache.ts"
import { projectFetchedSkills } from "./managed-skills-service-projection.ts"
import type { ManagedSkillRefreshReason, SlateManagedSkillsServicePorts } from "./managed-skills-service-contracts.ts"

export type { ManagedSkillRefreshReason, SlateManagedSkillsServicePorts } from "./managed-skills-service-contracts.ts"

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error
}

export class SlateManagedSkillsService {
  private stopped = false
  private activeRefresh: Promise<void> | null = null
  private pendingReason: ManagedSkillRefreshReason | null = null

  constructor(readonly options: SlateManagedSkillsServicePorts) {}

  start(): void {
    void this.synchronize("startup")
  }

  onAuthenticationReady(): void {
    void this.synchronize("auth_change")
  }

  async ensureSkillIsCached(skillId: string): Promise<boolean> {
    const cached = readManagedSkillsCache(this.options.getCacheDir())
    if (cached?.skills.some((skill) => skill.id === skillId) === true) return true

    await this.synchronize("on_demand")
    return readManagedSkillsCache(this.options.getCacheDir())?.skills.some((skill) => skill.id === skillId) === true
  }

  dispose(): void {
    this.stopped = true
  }

  async synchronize(reason: ManagedSkillRefreshReason): Promise<void> {
    if (this.stopped) return
    if (this.activeRefresh !== null) {
      this.pendingReason = reason
      await this.activeRefresh
      return
    }

    this.activeRefresh = this.drainPendingRefreshes(reason)
    try {
      await this.activeRefresh
    } finally {
      this.activeRefresh = null
    }
  }

  private async drainPendingRefreshes(reason: ManagedSkillRefreshReason): Promise<void> {
    let nextReason: ManagedSkillRefreshReason | null = reason

    while (nextReason !== null && !this.stopped) {
      nextReason = null
      try {
        const fetched = await this.options.fetch()
        if (this.stopped) return
        writeManagedSkillsCache(this.options.getCacheDir(), projectFetchedSkills(fetched))
      } catch (error) {
        this.options.report?.({ extension: "managed_setup", kind: "managed_skills", errorClass: errorKind(error) })
      } finally {
        nextReason = this.pendingReason
        this.pendingReason = null
      }
    }
  }
}
