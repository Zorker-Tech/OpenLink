/**
 * The wire vocabulary of the gateway.
 *
 * A caller sends a command with its arguments, and what comes back is either a result or an error shaped the way the
 * desktop expects; both sides read the same few fields, named here.
 */
export function parseCommandArgs(body: string): unknown { return body.length > 0 ? JSON.parse(body) : {}; }
/** The commands that take no arguments at all: their handler calls the api without a body. */
const BODYLESS_COMMANDS = new Set<string>([
  "getTranscript",
  "listAgents",
  "countAgents",
  "listAllAutomations",
  "isAgentNetworkEnabled",
  "isGlobalSearchEnabled",
  "isEgressTunnelAvailable",
  "getSharingState",
  "skillsCatalog",
  "syncPluginSkills",
  "getPluginSyncStatus",
  "getSkillPublishTargets",
  "getListenerIntegrations",
  "autoUpdateBoxNow",
  "getBoxStoreStatus",
  "clearBoxStoreNow",
  "getHostStatus",
  "prepareBoxForRecreate",
  "getTeachRecordingStatus",
  "getTrays",
  "clearTrays",
  "getHostSettings",
  "getBoxSecretsStatus",
  "listRoutedMcpTools",
]);

/** Every command the gateway serves, by name. This list is the wire surface. */
const COMMAND_NAMES = [
  "getTranscript",
  "getAgentTranscript",
  "getAgentTranscriptPage",
  "openAgentWindowed",
  "getAgentTranscriptWindow",
  "openAgentTail",
  "getAgentTranscriptTail",
  "getAgentThread",
  "sendPrompt",
  "promptAcceptanceStatus",
  "respondToWidget",
  "resolveAutoReviewApproval",
  "resolveLocalToolPermission",
  "dismissWidget",
  "submitSecret",
  "reactToMessage",
  "appendConnectorCard",
  "listAgents",
  "countAgents",
  "searchAgents",
  "searchMedia",
  "createAgent",
  "createBackgroundAgent",
  "kickstartAgent",
  "requestDiskSaverAudit",
  "createGroup",
  "setGroupMembers",
  "updateAgent",
  "deleteAgent",
  "deleteAgents",
  "duplicateAgent",
  "setAgentUnread",
  "setAgentNotificationsEnabled",
  "setAgentNotifyOnUpdates",
  "setAgentHiddenFromSidebar",
  "openAgent",
  "setWindowFocused",
  "getAgentMemories",
  "deleteAgentMemory",
  "clearAgentMemories",
  "getAgentAutomations",
  "listAllAutomations",
  "isAgentNetworkEnabled",
  "isGlobalSearchEnabled",
  "isEgressTunnelAvailable",
  "getSharingState",
  "createRoomFromAgent",
  "createRoomInvite",
  "joinSharedRoom",
  "respondToRoomJoinRequest",
  "createSharedRoom",
  "addOwnAgentToSharedRoom",
  "removeOwnAgentFromSharedRoom",
  "setSharedRoomTyping",
  "leaveSharedRoom",
  "setAgentAutomationEnabled",
  "createAgentAutomation",
  "updateAgentAutomation",
  "deleteAgentAutomation",
  "runAgentAutomationNow",
  "broadcastToAgents",
  "getAgentWorkflows",
  "createAgentWorkflow",
  "updateAgentWorkflow",
  "setAgentWorkflowEnabled",
  "deleteAgentWorkflow",
  "runAgentWorkflowNow",
  "importAgentWorkflowText",
  "importAgentWorkflowUrl",
  "portAgentLocalSkills",
  "getConversationOutline",
  "skillsCatalog",
  "syncPluginSkills",
  "getPluginSyncStatus",
  "getSkillPublishTargets",
  "publishSkill",
  "resyncPublishedSkill",
  "unpublishSkill",
  "getAgentChannels",
  "connectChannel",
  "disconnectChannel",
  "refreshChannel",
  "getListenerIntegrations",
  "getListenerConnectUrl",
  "getSubagents",
  "getAsyncTasks",
  "setAgentAvatarBytes",
  "getAgentAvatar",
  "appendAgentTranscriptEntries",
  "replaceAgentTranscriptEntries",
  "getForeverBoxStatus",
  "getCloudAgentInfo",
  "ensureForeverBox",
  "resetForeverBox",
  "updateForeverBox",
  "autoUpdateBoxNow",
  "snapshotBoxStoreNow",
  "getBoxStoreStatus",
  "clearBoxStoreNow",
  "updateHostNow",
  "getHostStatus",
  "setBoxMigrating",
  "prepareBoxForRecreate",
  "resumeBoxAfterRecreate",
  "handBackForeverBox",
  "startTeachRecording",
  "stopTeachRecording",
  "getTeachRecordingStatus",
  "getTrays",
  "dismissTray",
  "clearTrays",
  "uploadAttachment",
  "readAttachmentImage",
  "readAttachmentText",
  "readAttachmentChunk",
  "getHostSettings",
  "setHostSettings",
  "setBoxSecrets",
  "getBoxSecretsStatus",
  "completeMcpOAuth",
  "requestWebAuthnCeremony",
  "refreshMcp",
  "listRoutedMcpTools",
  "executeRoutedMcpTool",
  "listBoxMcpServers",
] as const;

type GatewayCommandName = (typeof COMMAND_NAMES)[number];

/** The api behind the gateway, as a caller of it: the handlers only ever pass the body through. */
type GatewayApi = any;

/** One dispatch, by name: a command with a body parses it, a command without one calls the api as it is. */
type GatewayCommandHandler = (api: GatewayApi, body: string) => unknown;

function handlerFor(name: GatewayCommandName): GatewayCommandHandler {
  return (api, body) => (BODYLESS_COMMANDS.has(name) ? api[name]() : api[name](parseCommandArgs(body)));
}

export const SLATE_GATEWAY_COMMANDS: Readonly<Record<GatewayCommandName, GatewayCommandHandler>> = Object.fromEntries(
  COMMAND_NAMES.map((name) => [name, handlerFor(name)]),
) as Readonly<Record<GatewayCommandName, GatewayCommandHandler>>;
export const GATEWAY_PREPARE_UPGRADE_PATH = "/prepare-upgrade";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function isLoopbackHost(host: string): boolean { return LOOPBACK_HOSTS.has(host.trim().toLowerCase()); }
export interface AgentSummaryLike { readonly avatarDataUrl?: unknown; readonly [key: string]: unknown; }
export function stripSummaryInlineAvatar<T extends AgentSummaryLike>(summary: T): T { return summary.avatarDataUrl == null ? summary : { ...summary, avatarDataUrl: null }; }
export function stripSummaryRows<T extends AgentSummaryLike>(rows: readonly T[]): readonly T[] { let changed = false; const stripped = rows.map((row) => { const slim = stripSummaryInlineAvatar(row); if (slim !== row) changed = true; return slim; }); return changed ? stripped : rows; }
export function stripNullableSummary<T extends AgentSummaryLike>(summary: T | null): T | null { return summary == null ? null : stripSummaryInlineAvatar(summary); }
export function stripCreateAgentResult<T extends { readonly agent: AgentSummaryLike }>(result: T): T { const agent = stripSummaryInlineAvatar(result.agent); return agent === result.agent ? result : { ...result, agent }; }
/** The seven commands whose replies carry agent summaries: each strips the inline avatar before the reply leaves. */
const SLIM_OVERRIDES: Partial<Record<GatewayCommandName, GatewayCommandHandler>> = {
  listAgents: async (api: GatewayApi, _body: string) => stripSummaryRows((await SLATE_GATEWAY_COMMANDS.listAgents(api, "")) as never),
  updateAgent: async (api: GatewayApi, body: string) => stripNullableSummary((await SLATE_GATEWAY_COMMANDS.updateAgent(api, body)) as never),
  setGroupMembers: async (api: GatewayApi, body: string) => stripNullableSummary((await SLATE_GATEWAY_COMMANDS.setGroupMembers(api, body)) as never),
  setAgentAvatarBytes: async (api: GatewayApi, body: string) => stripNullableSummary((await SLATE_GATEWAY_COMMANDS.setAgentAvatarBytes(api, body)) as never),
  createAgent: async (api: GatewayApi, body: string) => stripCreateAgentResult((await SLATE_GATEWAY_COMMANDS.createAgent(api, body)) as never),
  createGroup: async (api: GatewayApi, body: string) => stripCreateAgentResult((await SLATE_GATEWAY_COMMANDS.createGroup(api, body)) as never),
  duplicateAgent: async (api: GatewayApi, body: string) => stripCreateAgentResult((await SLATE_GATEWAY_COMMANDS.duplicateAgent(api, body)) as never),
};

/** The same surface, with those seven replies slimmed: every other command is the same handler, by identity. */
export const SLATE_GATEWAY_SLIM_COMMANDS: Readonly<Record<GatewayCommandName, GatewayCommandHandler>> = Object.fromEntries(
  COMMAND_NAMES.map((name) => [name, SLIM_OVERRIDES[name] ?? SLATE_GATEWAY_COMMANDS[name]]),
) as Readonly<Record<GatewayCommandName, GatewayCommandHandler>>;
export function stripInlineAvatarsFromEvent(event: any): any {
  if (event.channel === "agents") { const agents = stripSummaryRows(event.payload.agents); return agents === event.payload.agents ? event : { channel: "agents", payload: { ...event.payload, agents } }; }
  if (event.channel === "agent-upserted") { const agent = stripSummaryInlineAvatar(event.payload.agent); return agent === event.payload.agent ? event : { channel: "agent-upserted", payload: { ...event.payload, agent } }; }
  return event;
}
