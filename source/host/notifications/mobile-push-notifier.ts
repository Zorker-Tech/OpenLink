import {
  SlateOsNotificationDecider,
  toNotificationSnapshot,
  type NotificationAgent,
  type NotificationTransition,
} from "../../shared/os-notification.ts"
import type { MobilePushInput } from "../../shared/mobile-push-contracts.ts"
import {
  pushPresenceAt,
  type MobileWindowPresence,
} from "./mobile-push-policy.ts"
import { mobilePushInputForTransition } from "./mobile-push-projection.ts"

export type { MobilePushInput } from "../../shared/mobile-push-contracts.ts"
export { SLATE_MOBILE_PUSH_FOCUS_FRESHNESS_MS } from "./mobile-push-policy.ts"

interface PendingAgentUpdate {
  readonly event: { readonly agent: NotificationAgent }
  readonly presence: MobileWindowPresence
}

export class SlateMobilePushNotifier {
  private readonly decider = new SlateOsNotificationDecider()
  private readonly currentTime: () => number
  private baselineReady = false
  private queuedUpdates: PendingAgentUpdate[] = []

  constructor(private readonly deps: {
    readonly notify: (input: MobilePushInput) => Promise<void>
    readonly now?: () => number
  }) {
    this.currentTime = deps.now ?? Date.now
  }

  seedBaseline(agents: readonly NotificationAgent[]): void {
    this.decider.seedBaseline(agents.map(toNotificationSnapshot))
    this.replayQueuedUpdates()
  }

  handleAgentsEvent(
    event: { readonly agents: readonly NotificationAgent[] },
    presence: MobileWindowPresence,
  ): void {
    const context = pushPresenceAt(this.currentTime(), presence)
    const transitions = this.decider.decide({
      agents: event.agents.map(toNotificationSnapshot),
      ...context,
    })
    this.replayQueuedUpdates()
    for (const transition of transitions) this.send(transition)
  }

  handleAgentUpsertedEvent(
    event: { readonly agent: NotificationAgent },
    presence: MobileWindowPresence,
  ): void {
    if (!this.baselineReady) {
      this.queuedUpdates.push({ event, presence })
      return
    }
    const context = pushPresenceAt(this.currentTime(), presence)
    for (const transition of this.decider.decideAgent(toNotificationSnapshot(event.agent), context)) {
      this.send(transition)
    }
  }

  forget(agentId: string): void {
    this.decider.forget(agentId)
  }

  private replayQueuedUpdates(): void {
    if (this.baselineReady) return
    this.baselineReady = true
    const queued = this.queuedUpdates
    this.queuedUpdates = []
    for (const update of queued) this.handleAgentUpsertedEvent(update.event, update.presence)
  }

  private send(transition: NotificationTransition): void {
    void this.deps.notify(mobilePushInputForTransition(transition)).catch(() => {})
  }
}
