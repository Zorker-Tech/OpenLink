/**
 * Where a session's own files are.
 *
 * A session is a directory under the platform's root, and what is read from it is checked to be the file it should be
 * — a path that points at a symbolic link is followed only within the root.
 */
export {
  ACTIVE_AGENT_FILE as ACTIVE_AGENT_FILENAME,
  AGENT_DATABASE_FILE as STORE_FILENAME,
  CONNECTOR_SECRET_ROOT_FOLDER as CONNECTOR_SECRETS_DIRNAME,
  CONVERSATION_BLOB_DATABASE_FILE as CONVERSATION_BLOBS_FILENAME,
  HIDDEN_ENTRY_FIX_SCHEMA_VERSION as HIDDEN_ENTRY_REPAIR_VERSION,
  LEGACY_GROUP_MEMBER_FOLDER as LEGACY_GROUP_MEMBERS_DIRNAME,
  LIVE_CONVERSATION_ROOT_MARKER_BYTES as SLATE_CONVERSATION_ROOT_SLOT_ID,
  STALE_ROOT_GC_SCHEMA_VERSION as STALE_ROOT_CLEANUP_VERSION,
} from "./session-path-contracts.ts";
export {
  agentDatabasePath as getAgentDbPath,
  connectorSecretDirectory as getConnectorSecretsRoot,
  transcriptDirectory as getSlateTranscriptsDir,
} from "./session-path-resolver.ts";
export {
  setStaleRootGcOverride as pinStaleRootGc,
  shouldCollectStaleSessionRoots as isStaleRootGcEnabled,
} from "./session-root-gc-policy.ts";
export { inspectPathIfPresent as statIfExists } from "./session-filesystem-probe.ts";
