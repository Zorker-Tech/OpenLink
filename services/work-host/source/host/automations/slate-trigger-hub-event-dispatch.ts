import { triggerMatchesEvent } from "./automation-trigger.ts";
import type { ScheduledAutomation, SlateTriggerHubDependencies } from "./slate-trigger-hub-contracts.ts";

export async function dispatchTriggerEvent(
  deps: SlateTriggerHubDependencies,
  event: Record<string, unknown>,
  isStopped: () => boolean,
): Promise<void> {
  if (isStopped() || !await deps.isReady()) return;

  let automations: readonly ScheduledAutomation[];
  try {
    automations = await deps.listAutomations();
  } catch {
    return;
  }

  for (const { agentId, automation } of automations) {
    if (!automation.isEnabled || !triggerMatchesEvent(automation.trigger, event)) continue;
    try {
      if (!(deps.shouldScheduleLocally?.(agentId, automation) ?? true)) continue;
      await deps.fire(agentId, automation, event);
    } catch {
      // One automation failing does not prevent matching listeners later in the list from firing.
    }
  }
}
