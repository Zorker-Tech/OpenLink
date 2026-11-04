import { triggerListeners, type EventTrigger } from "../../shared/automations.ts";
import type { ScheduledAutomation, SlateTriggerHubDependencies } from "./slate-trigger-hub-contracts.ts";

export async function collectDesiredListeners(
  deps: SlateTriggerHubDependencies,
): Promise<Map<string, EventTrigger[]>> {
  const listenersByKind = new Map<string, EventTrigger[]>();
  const automations = await deps.listAutomations();
  for (const { agentId, automation } of automations) {
    if (!automation.isEnabled) continue;
    const local = deps.shouldScheduleLocally?.(agentId, automation) ?? true;
    if (!local) continue;

    for (const listener of triggerListeners(automation.trigger)) {
      const bucket = listenersByKind.get(listener.type) ?? [];
      bucket.push(listener);
      listenersByKind.set(listener.type, bucket);
    }
  }
  return listenersByKind;
}
