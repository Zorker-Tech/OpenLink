/**
 * The coordinator's side of its own RPC surface.
 *
 * What a call may be is named here and dispatched to the handler that serves it, and a call that names nothing the
 * coordinator knows is answered as unknown rather than ignored.
 */
export interface TranscriptEntry {
  readonly id: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface WindowRequest {
  readonly id: string;
  readonly beforeSeq?: number;
  readonly limit?: number;
}

export interface WindowReply {
  readonly entries: readonly TranscriptEntry[];
  readonly nextBeforeSeq?: number;
  readonly threadCounts: Readonly<Record<string, number>>;
}

export interface ThreadRequest {
  readonly id: string;
  readonly rootId: string;
}

export interface ThreadReply {
  readonly entries: readonly TranscriptEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An entry the transcript can page over: it has an id and a kind, and both are non-empty. */
const isEntry = (value: unknown): value is TranscriptEntry =>
  isRecord(value) && typeof value.id === "string" && value.id.length > 0 && typeof value.kind === "string" && value.kind.length > 0;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A list of entries, or nothing: every entry in the reply has to be one. */
function entriesIn(value: Record<string, unknown>): TranscriptEntry[] | null {
  return Array.isArray(value.entries) && value.entries.every(isEntry) ? value.entries : null;
}

/** The counts per thread root, or nothing: an empty root or a count that is not a number is a malformed reply. */
function threadCountsIn(value: Record<string, unknown>): Record<string, number> | null {
  if (!isRecord(value.threadCounts)) return null;
  const counts: Record<string, number> = {};
  for (const [rootId, count] of Object.entries(value.threadCounts)) {
    if (rootId.length === 0 || !isFiniteNumber(count)) return null;
    counts[rootId] = count;
  }
  return counts;
}

/** A paged window of a transcript, with where to continue from and how many entries each thread has. */
export function parseCoordinatorTranscriptWindowResponse(value: unknown): WindowReply | null {
  if (!isRecord(value)) return null;
  const entries = entriesIn(value);
  const threadCounts = threadCountsIn(value);
  if (entries === null || threadCounts === null) return null;
  if (value.nextBeforeSeq !== undefined && !isFiniteNumber(value.nextBeforeSeq)) return null;
  return { entries, ...(value.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: value.nextBeforeSeq }), threadCounts };
}

/** The window a caller asks for: a conversation, and optionally where to page from and how much to take. */
export function parseCoordinatorTranscriptWindowRequest(value: unknown): WindowRequest | null {
  if (!isRecord(value)) return null;
  const { id, beforeSeq, limit } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  // A page cursor is a whole sequence number; a limit is only a number.
  if (beforeSeq !== undefined && (!isFiniteNumber(beforeSeq) || !Number.isInteger(beforeSeq))) return null;
  if (limit !== undefined && !isFiniteNumber(limit)) return null;
  return { id, ...(beforeSeq === undefined ? {} : { beforeSeq }), ...(limit === undefined ? {} : { limit }) };
}

export function parseCoordinatorAgentThreadResponse(value: unknown): ThreadReply | null {
  if (!isRecord(value)) return null;
  const entries = entriesIn(value);
  return entries === null ? null : { entries };
}

export function parseCoordinatorAgentThreadRequest(value: unknown): ThreadRequest | null {
  if (!isRecord(value)) return null;
  const { id, rootId } = value;
  return typeof id === "string" && id.length > 0 && typeof rootId === "string" && rootId.length > 0 ? { id, rootId } : null;
}

/** The two replies the coordinator validates, by the method that answers them. */
export function validateCoordinatorReply(method: string, value: unknown): unknown {
  if (method === "getAgentTranscriptWindow" && parseCoordinatorTranscriptWindowResponse(value) == null) {
    throw new Error("getAgentTranscriptWindow returned a malformed transcript window");
  }
  if (method === "getAgentThread" && parseCoordinatorAgentThreadResponse(value) == null) {
    throw new Error("getAgentThread returned a malformed agent thread");
  }
  return value;
}

/**
 * Every method the coordinator serves, and what it takes and answers with — `args/reply`, where the arguments are `object`
 * or `none` and the reply names the shape (a paged window, an agent thread, a record that may be null, nothing at all).
 *
 * This table is the surface itself: its keys are the method names the gateway and the renderer call, so they are the wire
 * values they are, and a method that is not in here is answered as unknown rather than ignored.
 */
export const COORDINATOR_METHOD_TABLE = {
  getAgentTranscriptWindow: "object/transcript-window",
  getAgentThread: "object/agent-thread",
  getAgentTranscriptTail: "object/transcript-page",
  openAgentTail: "object/transcript-page",
  sendPrompt: "object/send-result",
  promptAcceptanceStatus: "object/acceptance-lookup",
  respondToWidget: "object/record-or-null",
  resolveAutoReviewApproval: "object/void",
  resolveLocalToolPermission: "object/void",
  dismissWidget: "object/record",
  submitSecret: "object/void",
  reactToMessage: "object/void",
  listAgents: "none/array",
  countAgents: "none/count",
  searchAgents: "object/array",
  searchMedia: "object/array",
  createAgent: "object/record",
  createBackgroundAgent: "object/record",
  createGroup: "object/record",
  setGroupMembers: "object/record-or-null",
  updateAgent: "object/record-or-null",
  deleteAgents: "object/record",
  duplicateAgent: "object/record",
  kickstartAgent: "object/record-or-null",
  requestDiskSaverAudit: "object/record-or-null",
  broadcastToAgents: "object/record",
  getCloudAgentInfo: "object/record-or-null",
  getListenerIntegrations: "none/record",
  getListenerConnectUrl: "object/connect-url",
  setAgentUnread: "object/void",
  setAgentHiddenFromSidebar: "object/void",
  setAgentNotificationsEnabled: "object/void",
  setAgentNotifyOnUpdates: "object/void",
  setAgentAvatarBytes: "object/record-or-null",
  getAgentAvatar: "object/record",
  appendAgentTranscriptEntries: "object/record",
  replaceAgentTranscriptEntries: "object/record",
  getAgentWorkflows: "object/array",
  createAgentWorkflow: "object/array",
  updateAgentWorkflow: "object/array",
  setAgentWorkflowEnabled: "object/array",
  deleteAgentWorkflow: "object/array",
  runAgentWorkflowNow: "object/void",
  importAgentWorkflowText: "object/import-result",
  importAgentWorkflowUrl: "object/import-result",
  portAgentLocalSkills: "object/import-result",
  getConversationOutline: "object/array",
  skillsCatalog: "none/array",
  syncPluginSkills: "none/array",
  getPluginSyncStatus: "none/record",
  listRoutedMcpTools: "none/array",
  executeRoutedMcpTool: "object/record",
  getSkillPublishTargets: "none/record",
  publishSkill: "object/record",
  resyncPublishedSkill: "object/record",
  unpublishSkill: "object/record",
  getSubagents: "object/array",
  getAsyncTasks: "object/array",
  getForeverBoxStatus: "object/box-status",
  ensureForeverBox: "object/box-status",
  handBackForeverBox: "object/void",
  startTeachRecording: "object/record",
  stopTeachRecording: "object/record",
  getTeachRecordingStatus: "none/record",
  getTrays: "none/array",
  dismissTray: "object/void",
  clearTrays: "none/void",
  getAgentChannels: "object/channels-view",
  connectChannel: "object/channels-view",
  disconnectChannel: "object/channels-view",
  refreshChannel: "object/channels-view",
  getBoxSecretsStatus: "none/box-secrets",
  getAgentAutomations: "object/array",
  listAllAutomations: "none/array",
  isAgentNetworkEnabled: "none/boolean",
  isGlobalSearchEnabled: "none/boolean",
  isEgressTunnelAvailable: "none/boolean",
  getSharingState: "none/record",
  createRoomFromAgent: "object/record",
  createRoomInvite: "object/record",
  joinSharedRoom: "object/record",
  respondToRoomJoinRequest: "object/record",
  createSharedRoom: "object/record",
  addOwnAgentToSharedRoom: "object/record",
  removeOwnAgentFromSharedRoom: "object/record",
  setSharedRoomTyping: "object/void",
  leaveSharedRoom: "object/record",
  setAgentAutomationEnabled: "object/array",
  createAgentAutomation: "object/array",
  updateAgentAutomation: "object/array",
  deleteAgentAutomation: "object/array",
  runAgentAutomationNow: "object/void",
} as const;

export type CoordinatorMethod = keyof typeof COORDINATOR_METHOD_TABLE;

export function isCoordinatorMethod(name: string): name is CoordinatorMethod {
  return Object.hasOwn(COORDINATOR_METHOD_TABLE, name);
}
