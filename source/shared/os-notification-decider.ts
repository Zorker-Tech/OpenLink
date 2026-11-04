import {
  SLATE_OS_NOTIFICATION_THROTTLE_MS,
  type NotificationDecisionContext,
  type NotificationPolicyInput,
  type NotificationSnapshot,
  type NotificationTransition,
} from "./os-notification-contracts.ts";
import { diffAgentNotificationTransitions } from "./os-notification-snapshot.ts";
import { notificationThrottleKey, shouldNotify } from "./os-notification-policy.ts";

/** Keeps per-agent transition, message-accounting, and throttle state. */
export class SlateOsNotificationDecider {
  private previous = new Map<string, NotificationSnapshot>();
  private readonly lastDeliveredAt = new Map<string, number>();
  private readonly accountedMessageId = new Map<string, string | null | undefined>();

  constructor(readonly throttleWindowMs = SLATE_OS_NOTIFICATION_THROTTLE_MS) {}

  /** Evaluate a full snapshot and replace the known-agent transition baseline. */
  decide(input: {
    readonly agents: readonly NotificationSnapshot[];
    readonly isWindowFocused: boolean;
    readonly nowMs: number;
  }): NotificationTransition[] {
    const transitions = diffAgentNotificationTransitions(this.previous, input.agents);
    const deliverable = this.gateTransitions(transitions, input);
    const current = new Map<string, NotificationSnapshot>();
    for (const agent of input.agents) {
      this.rememberMessageIfUnknown(agent);
      current.set(agent.id, agent);
    }
    this.previous = current;
    return deliverable;
  }

  /** Add initial state without treating it as a newly produced update. */
  seedBaseline(agents: readonly NotificationSnapshot[]): void {
    for (const agent of agents) {
      if (!this.previous.has(agent.id)) this.previous.set(agent.id, agent);
      this.rememberMessageIfUnknown(agent);
    }
  }

  /** Evaluate one agent while leaving all other agents' baselines untouched. */
  decideAgent(agent: NotificationSnapshot, context: NotificationDecisionContext): NotificationTransition[] {
    const transitions = diffAgentNotificationTransitions(this.previous, [agent]);
    const deliverable = this.gateTransitions(transitions, context);
    this.rememberMessageIfUnknown(agent);
    this.previous.set(agent.id, agent);
    return deliverable;
  }

  /** Observe an agent without emitting or advancing delivery timestamps. */
  observeAgent(agent: NotificationSnapshot): void {
    this.rememberMessageIfUnknown(agent);
    this.previous.set(agent.id, agent);
  }

  /** Drop all state for an agent that is no longer part of the workspace. */
  forget(agentId: string): void {
    this.previous.delete(agentId);
    this.accountedMessageId.delete(agentId);
    this.lastDeliveredAt.delete(notificationThrottleKey(agentId, "agent-done"));
    this.lastDeliveredAt.delete(notificationThrottleKey(agentId, "agent-needs-input"));
  }

  private rememberMessageIfUnknown(agent: NotificationSnapshot): void {
    if (!this.accountedMessageId.has(agent.id)) this.accountedMessageId.set(agent.id, agent.lastMessageId);
  }

  private gateTransitions(
    transitions: readonly NotificationTransition[],
    context: NotificationDecisionContext,
  ): NotificationTransition[] {
    const deliverable: NotificationTransition[] = [];
    for (const transition of transitions) {
      const accountedMessage = this.accountedMessageId.get(transition.agentId) ?? null;
      if (this.isAlreadyAccountedCompletion(transition, accountedMessage)) continue;
      this.accountedMessageId.set(transition.agentId, transition.lastMessageId);

      const key = notificationThrottleKey(transition.agentId, transition.kind);
      const policy: NotificationPolicyInput = {
        notifyEnabled: transition.notifyEnabled,
        isHidden: transition.isHiddenFromSidebar,
        isWindowFocused: context.isWindowFocused,
        nowMs: context.nowMs,
        lastNotifiedAtMs: this.lastDeliveredAt.get(key) ?? null,
        throttleWindowMs: this.throttleWindowMs,
      };
      if (!shouldNotify(policy)) continue;
      this.lastDeliveredAt.set(key, context.nowMs);
      deliverable.push(transition);
    }
    return deliverable;
  }

  private isAlreadyAccountedCompletion(transition: NotificationTransition, messageId: string | null): boolean {
    return transition.kind === "agent-done"
      && (transition.lastMessageId == null || transition.lastMessageId === messageId);
  }
}
