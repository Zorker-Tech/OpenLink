/** Agent-core constructors for privacy-aware interaction updates. */
export {
  RedactedUpdates,
  type ContextInjectionState,
  type RedactedFeedbackCategory,
  type RedactedFeedbackCategoryGroup,
} from "../../adapters/interop/agent/redacted-interaction-updates-adapter.ts";
export { slateRedactedTurnEndedUpdate } from "./slate-interaction-updates.ts"
export type { SlateRedactedTurnEndedUpdate } from "./interaction-update-contracts.ts"
