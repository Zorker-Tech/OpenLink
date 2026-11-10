/**
 * What an automation run left in a transcript.
 *
 * A run is written as an entry a reader can read — what woke it, what it did and how it ended — and a run that was already
 * written is not written twice.
 */
import { triggerIdentity } from "../automations/automation-trigger.ts"
import type { AutomationRecord } from "../automations/automation.ts"

type AutomationSnapshotFields = Pick<
  AutomationRecord,
  "id" | "name" | "prompt" | "schedule" | "isEnabled" | "createdAt"
>

export type AutomationSnapshot = AutomationSnapshotFields & {
  readonly trigger: string
  readonly triggerType: AutomationRecord["trigger"]["type"]
  readonly recordedRunCount: number
}

export function snapshotAutomations(automations: readonly AutomationRecord[]): Map<string, AutomationSnapshot> {
  return new Map(automations.map(automation => [automation.id, toSnapshot(automation)]))
}

function toSnapshot(automation: AutomationRecord): AutomationSnapshot {
  return {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    trigger: triggerIdentity(automation.trigger),
    triggerType: automation.trigger.type,
    schedule: automation.schedule,
    isEnabled: automation.isEnabled,
    createdAt: automation.createdAt,
    recordedRunCount: automation.runs.length,
  }
}

function changedDescription(before: AutomationSnapshot, after: AutomationSnapshot): boolean {
  return before.name !== after.name || before.prompt !== after.prompt || before.trigger !== after.trigger
}

export function diffAutomationAction(
  before: AutomationSnapshot,
  after: AutomationSnapshot,
): "updated" | "enabled" | "disabled" | null {
  if (changedDescription(before, after)) return "updated"
  if (before.isEnabled === after.isEnabled) return null
  return after.isEnabled ? "enabled" : "disabled"
}
