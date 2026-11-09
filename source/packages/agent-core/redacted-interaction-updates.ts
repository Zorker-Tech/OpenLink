/** Agent-core constructors for privacy-aware interaction updates. */
export {
  slateUserMessageAppendedUpdate,
  unredactSlateUserMessage,
} from "../../adapters/interop/agent/redacted-interaction-updates-adapter.ts";
export { SlateRedactedInteractionUpdates, slateRedactedTurnEndedUpdate } from "./slate-interaction-updates.ts"
export type {
  SlateRedactedActiveBranchChangeUpdate,
  SlateRedactedHeartbeatUpdate,
  SlateRedactedInteractionUpdate,
  SlateRedactedPromptSuggestionUpdate,
  SlateRedactedSummaryUpdate,
  SlateRedactedSummaryStartedUpdate,
  SlateRedactedSummaryCompletedUpdate,
  SlateRedactedStepCompletedUpdate,
  SlateRedactedStepStartedUpdate,
  SlateRedactedThinkingCompletedUpdate,
  SlateRedactedThinkingDeltaUpdate,
  SlateRedactedTextDeltaUpdate,
  SlateRedactedToolCallUpdate,
  SlateRedactedToolCallDeltaUpdate,
  SlateRedactedTokenDeltaUpdate,
  SlateRedactedTurnEndedUpdate,
  SlateRedactedUserMessageAppendedUpdate,
  SlateRedactedFeedbackRequestUpdate,
  SlateFeedbackRequestCategory,
  SlateFeedbackRequestCategoryGroup,
  SlateRedactedShellOutputUpdate,
  SlateRedactedSandboxRule,
  SlateToolCallUpdatePhase,
  SlateToolCallDeltaValue,
} from "./interaction-update-contracts.ts"
