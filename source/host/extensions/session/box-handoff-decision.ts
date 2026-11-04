import type { HandoffTrigger, PendingHandoff } from "./box-handoff-contracts.ts";

export type HandoffDecision =
  | { kind: "none" }
  | { kind: "end"; requestId: string; resolution: string; trigger: string };

export function decideBoxHandBack(
  pending: PendingHandoff | undefined,
  trigger: HandoffTrigger,
): HandoffDecision {
  if (pending === undefined) return { kind: "none" };

  if (typeof trigger === "string") {
    return {
      kind: "end",
      requestId: pending.requestId,
      resolution: trigger === "cancel" ? "cancelled" : "completed",
      trigger,
    };
  }

  return {
    kind: "end",
    requestId: pending.requestId,
    resolution: trigger.resolution ?? "completed",
    trigger: trigger.trigger ?? "unknown",
  };
}
