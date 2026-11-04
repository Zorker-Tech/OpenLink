/**
 * Telling a real user message from one the platform wrote.
 *
 * Not every user-role message came from the user: a summary stands in for a conversation, a notification
 * wakes the agent, a goal continuation says to keep going. They have to be told apart because the rules
 * about user messages — render it, treat it as a turn, count it — apply to the real ones, and a summary
 * treated as a new request would start a turn nobody asked for.
 *
 * A notification is recognized by being *only* notifications: the tags are tracked as a stack, and a
 * notification at the top level with nothing around it is the whole message. Text that merely mentions a
 * notification tag inside another element is a real message that happens to quote one.
 */

import { SYSTEM_NOTIFICATION_TAG } from "../../../constants/system-notification.ts";
import { hasCounterpartSummaryOrigin } from "../../../../adapters/interop/cursor-backend/summary-origin-marker-adapter.ts";
import {
  getUserMessageTextContent,
  isNotificationOnlyUserMessage,
  NOTIFICATION_TAG_NAMES,
  type UserMessageCandidate,
} from "./notification-message-classifier.ts";

export {
  getUserMessageTextContent,
  isNotificationOnlyUserMessage,
  NOTIFICATION_TAG_NAMES,
} from "./notification-message-classifier.ts";

export function isGoalContinuationNotificationMessage(message: UserMessageCandidate): boolean {
  return getUserMessageTextContent(message)?.includes(
    `<${SYSTEM_NOTIFICATION_TAG} source="goal"`,
  ) === true;
}

export function isSyntheticUserMessage(message: UserMessageCandidate): boolean {
  return hasCounterpartSummaryOrigin(message) || isNotificationOnlyUserMessage(message);
}
