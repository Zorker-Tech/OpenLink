/** Public conversation-capacity surface, composed from limit policy, GC and maintenance behavior. */
export {
  HARD_LIMIT_DEFAULT_BYTES,
  SOFT_GC_MIN_INTERVAL_MS,
  SOFT_LIMIT_DEFAULT_BYTES,
  conversationHardLimitBytes,
  conversationSoftLimitBytes,
  isConversationGcEnabled,
  pinConversationGc,
  pinConversationSizeLimitsReader,
} from "./conversation-size-limits-config.ts";
export type {
  ConversationGcReport,
  ConversationGcVerdict,
  ConversationSizeLimits,
} from "./conversation-size-limits-contracts.ts";
export { GC_PENDING_WRITE_RETENTION_MS } from "./conversation-size-limits-config.ts";
export {
  blobDbPathFor,
  measureConversationBlobBytes,
  pinConversationGcReporter,
  reportConversationGcVerdict,
  runConversationGc,
} from "./conversation-size-garbage-collection.ts";
export {
  ensureConversationCapacityForTurn,
  scheduleConversationSizeMaintenance,
  SlateConversationTooLargeError,
} from "./conversation-size-maintenance.ts";
