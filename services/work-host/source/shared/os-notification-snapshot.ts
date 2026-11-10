import type { NotificationAgent, NotificationSnapshot, NotificationTransition } from "./os-notification-contracts.ts";

/** Project an agent event into the fields used by notification decisions. */
export function toNotificationSnapshot(agent: NotificationAgent): NotificationSnapshot {
  return {
    id: agent.id,
    name: agent.name,
    isRunning: agent.isRunning,
    awaitingReason: agent.awaitingUserResponse?.reason ?? null,
    notifyEnabled: agent.notifyOnUpdatesEnabled,
    isHiddenFromSidebar: agent.isHiddenFromSidebar === true,
    ...(agent.lastMessageId === undefined ? {} : { lastMessageId: agent.lastMessageId }),
    lastMessagePreview: agent.lastMessagePreview ?? null,
  };
}

function transitionFor(previous: NotificationSnapshot, current: NotificationSnapshot): NotificationTransition | null {
  const newlyAwaiting = current.awaitingReason != null && previous.awaitingReason == null;
  const turnFinished = previous.isRunning && !current.isRunning && current.awaitingReason == null;
  if (!newlyAwaiting && !turnFinished) return null;

  return {
    agentId: current.id,
    agentName: current.name,
    kind: newlyAwaiting ? "agent-needs-input" : "agent-done",
    reason: newlyAwaiting ? current.awaitingReason : null,
    notifyEnabled: current.notifyEnabled,
    isHiddenFromSidebar: current.isHiddenFromSidebar,
    ...(current.lastMessageId === undefined ? {} : { lastMessageId: current.lastMessageId }),
    lastMessagePreview: current.lastMessagePreview,
  };
}

/** Return one transition per changed agent, in the order of the incoming snapshot. */
export function diffAgentNotificationTransitions(
  previous: ReadonlyMap<string, NotificationSnapshot>,
  next: readonly NotificationSnapshot[],
): NotificationTransition[] {
  const transitions: NotificationTransition[] = [];
  for (const current of next) {
    const before = previous.get(current.id);
    if (before == null) continue;
    const transition = transitionFor(before, current);
    if (transition !== null) transitions.push(transition);
  }
  return transitions;
}
