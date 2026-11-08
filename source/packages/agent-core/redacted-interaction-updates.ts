/** Agent-core constructors for privacy-aware interaction updates. */
export {
  RedactedUpdates,
  type ContextInjectionState,
  type RedactedFeedbackCategory,
  type RedactedFeedbackCategoryGroup,
} from "../../adapters/interop/agent/redacted-interaction-updates-adapter.ts";
export { SlateRedactedInteractionUpdates, slateRedactedTurnEndedUpdate } from "./slate-interaction-updates.ts"
export type {
  SlateRedactedHeartbeatUpdate,
  SlateRedactedInteractionUpdate,
  SlateRedactedThinkingCompletedUpdate,
  SlateRedactedThinkingDeltaUpdate,
  SlateRedactedTextDeltaUpdate,
  SlateRedactedTokenDeltaUpdate,
  SlateRedactedTurnEndedUpdate,
} from "./interaction-update-contracts.ts"
