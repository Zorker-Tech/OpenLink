import type { EventTrigger } from "../../shared/automations.ts";
import type { TriggerSource } from "./slate-trigger-hub-contracts.ts";

export async function synchronizeTriggerSources(
  sources: Map<string, TriggerSource>,
  activeKinds: Set<string>,
  desired: Map<string, EventTrigger[]>,
  accept: (event: Record<string, unknown>) => boolean,
): Promise<void> {
  for (const [kind, source] of sources) {
    const listeners = desired.get(kind) ?? [];
    if (listeners.length > 0) {
      source.setListeners(listeners);
      if (!activeKinds.has(kind)) {
        activeKinds.add(kind);
        try {
          await source.start(accept);
        } catch {
          activeKinds.delete(kind);
        }
      }
      continue;
    }

    if (!activeKinds.has(kind)) continue;
    activeKinds.delete(kind);
    try {
      await source.stop();
    } catch {
      // A source that is already down must not block its peers from reconciling.
    }
  }
}
