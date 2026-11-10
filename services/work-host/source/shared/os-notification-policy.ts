import type { NotificationPolicyInput, NotificationTransition } from "./os-notification-contracts.ts";

/** Decide whether a candidate is eligible for delivery at this moment. */
export function shouldNotify(input: NotificationPolicyInput): boolean {
  if (input.isHidden || !input.notifyEnabled || input.isWindowFocused) return false;
  if (input.lastNotifiedAtMs == null) return true;
  return input.nowMs - input.lastNotifiedAtMs >= input.throttleWindowMs;
}

export function notificationThrottleKey(agentId: string, kind: NotificationTransition["kind"]): string {
  return `${agentId}:${kind}`;
}
