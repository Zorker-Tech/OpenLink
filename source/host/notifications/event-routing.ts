import type { NotificationAgent } from "../../shared/os-notification.ts"
import type { MobileWindowPresence } from "./mobile-push-policy.ts"

export type NotificationHostEvent =
  | { readonly kind: "notification-baseline"; readonly agents: readonly NotificationAgent[] }
  | { readonly kind: "notification-agents"; readonly event: { readonly agents: readonly NotificationAgent[] }; readonly presence: MobileWindowPresence }
  | { readonly kind: "notification-agent-upserted"; readonly event: { readonly agent: NotificationAgent }; readonly presence: MobileWindowPresence }
  | { readonly kind: "notification-agent-forgotten"; readonly agentId: string }

export interface NotificationEventTarget {
  seedBaseline(agents: readonly NotificationAgent[]): void
  handleAgentsEvent(event: { readonly agents: readonly NotificationAgent[] }, presence: MobileWindowPresence): void
  handleAgentUpsertedEvent(event: { readonly agent: NotificationAgent }, presence: MobileWindowPresence): void
  forget(agentId: string): void
}

/** Routes each host-owned event to the state transition it describes. */
export function dispatchNotificationHostEvent(target: NotificationEventTarget, event: NotificationHostEvent): void {
  switch (event.kind) {
    case "notification-baseline":
      target.seedBaseline(event.agents)
      return
    case "notification-agents":
      target.handleAgentsEvent(event.event, event.presence)
      return
    case "notification-agent-upserted":
      target.handleAgentUpsertedEvent(event.event, event.presence)
      return
    case "notification-agent-forgotten":
      target.forget(event.agentId)
      return
  }
}
