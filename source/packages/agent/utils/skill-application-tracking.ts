import type { Context } from "../../context/context.ts"
import { createCounter } from "../../metrics/index.ts"
import { getAgentEventTracker } from "./agent-event-tracker-context.ts"
import type { RecordSkillAppliedInput } from "./agent-event-tracker-contracts.ts"

const skillApplied = createCounter("skill.applied", {
  description: "Skill applications (e.g. SKILL.md reads), tagged by the catalog truncation that ran for the current turn, the skill source, and the entrypoint that triggered the application",
  labelNames: ["truncation", "skill_source", "entrypoint"],
})

/** A hand-attached skill bypasses the catalog budget that normally selects skills for a turn. */
export function recordSkillApplied(context: Context, input: RecordSkillAppliedInput): void {
  const truncation = input.entrypoint === "manually_attached"
    ? "bypassed"
    : input.stateHandler?.lastSkillCatalogBudgetStrategy ?? "none"
  getAgentEventTracker(context).trackSkillApplied(context, {
    skillId: input.skillId,
    skillSource: input.skillSource,
    entrypoint: input.entrypoint,
    plugin: input.plugin,
    marketplace: input.marketplace,
    pluginId: input.pluginId,
    marketplaceId: input.marketplaceId,
  })
  skillApplied.increment(context, 1, {
    truncation,
    skill_source: input.skillSource,
    entrypoint: input.entrypoint,
  })
}
