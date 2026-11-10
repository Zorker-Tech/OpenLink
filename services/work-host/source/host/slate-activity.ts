/** Public activity contract, transition rules and tool-detail projection used by the conversation surfaces. */
export {
  INITIAL_NAMED_ACTIVITY_HOLD_STATE,
  MAX_ACTIVITY_DETAIL_CHARS,
  NAMED_ACTIVITY_MAX_HOLD_MS,
  SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME,
  SLATE_BOX_AWAIT_SHELL_TOOL_NAME,
  SLATE_BOX_READ_TOOL_NAME,
  SLATE_BOX_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_READ_TOOL_NAME,
  SLATE_EXTERNAL_SHELL_TOOL_NAME,
  THINKING_ACTIVITY,
} from "./slate-activity-contracts.ts";
export type { ActivityTransition, ActivityUpdate, AgentActivity, NamedActivityHoldState } from "./slate-activity-contracts.ts";
export {
  createGroupMemberActivityTracker,
  deriveActivityFromUpdate,
  resolveNamedActivityHold,
} from "./slate-activity-transitions.ts";
export {
  deriveToolCallActivity,
} from "./slate-activity-tool-projection.ts";
export {
  extractShellEditTarget,
  fileBasename,
  parseArgsJson,
  urlHostname,
} from "./slate-activity-shell-paths.ts";
