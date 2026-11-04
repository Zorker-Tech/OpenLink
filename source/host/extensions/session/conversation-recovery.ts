/** Public transcript-rebuild and root-validation operations for session recovery. */

export {
  MAX_ROOT_BLOB_BYTES,
  REBUILT_ENTRY_ID_PREFIX,
} from "./conversation-recovery-contracts.ts";
export type { OutlineItem } from "./conversation-recovery-contracts.ts";

export {
  rebuildTranscriptEntriesFromState,
  selectHiddenArtifactEntryIds,
} from "./conversation-recovery-transcript.ts";

export {
  conversationStructureFullyResolves,
  scoreRootCandidate,
  isBetterRoot,
  findLatestRootBlobIdInDatabase,
} from "./conversation-recovery-roots.ts";
