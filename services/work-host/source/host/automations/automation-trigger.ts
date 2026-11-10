/** Public parsing, matching and context API for automation triggers. */

export {
  TRIGGER_MAX_ALLOWLIST_LOGIN_LENGTH,
  TRIGGER_MAX_ALLOWLIST_LOGINS,
  TRIGGER_MAX_BRANCH_LENGTH,
  TRIGGER_MAX_CHANNEL_LENGTH,
  TRIGGER_MAX_FILTER_IDS,
  TRIGGER_MAX_ID_LENGTH,
  TRIGGER_MAX_KEYWORD_LENGTH,
  TRIGGER_MAX_REPO_LENGTH,
} from "./automation-trigger-contracts.ts";
export { buildTriggerEventContextBlock, describeTriggerEvent } from "./automation-trigger-context.ts";
export {
  githubListenerMatches,
  listenerMatchesEvent,
  slackListenerMatches,
  slackScopeMatches,
  triggerMatchesEvent,
} from "./automation-trigger-matching.ts";
export { parseStoredTrigger, serializeStoredTrigger, triggerIdentity } from "./automation-trigger-parse.ts";
