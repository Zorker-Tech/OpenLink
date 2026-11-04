export type ManagedSkillRefreshReason = "startup" | "auth_change" | "on_demand"

export interface SlateManagedSkillsServicePorts {
  getCacheDir(): string
  fetch(): Promise<readonly import("./slate-managed-skills.ts").FetchedManagedSkill[]>
  report?(event: { extension: "managed_setup"; kind: "managed_skills"; errorClass: string }): void
}
