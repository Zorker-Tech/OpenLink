import type { NotificationTransition } from "../../shared/os-notification.ts"
import type { MobilePushInput } from "../../shared/mobile-push-contracts.ts"

export function mobilePushInputForTransition(transition: NotificationTransition): MobilePushInput {
  return {
    agentId: transition.agentId,
    agentName: transition.agentName,
    ...(transition.lastMessagePreview == null ? {} : { messagePreview: transition.lastMessagePreview }),
    ...(transition.lastMessageId == null ? {} : { lastMessageId: transition.lastMessageId }),
    awaitingUserResponse: transition.kind === "agent-needs-input",
  }
}
