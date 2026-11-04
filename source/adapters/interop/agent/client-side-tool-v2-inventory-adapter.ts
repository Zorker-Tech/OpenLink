/**
 * The client-side tools this build ships.
 *
 * The list is the enum's non-unspecified values, written out so that a tool the platform does not support is visible
 * here rather than silently missing, and what the inventory says about a tool is what the projection acts on.
 */

// Exact non-UNSPECIFIED enum union recovered from tools_pb.ts. Keeping the full
// list here makes drift and unsupported variants reviewable rather than silent.
export const SHIPPED_CLIENT_SIDE_TOOL_V2_UNION = Object.freeze([
  "READ_SEMSEARCH_FILES", "RIPGREP_SEARCH", "READ_FILE", "LIST_DIR", "EDIT_FILE",
  "FILE_SEARCH", "SEMANTIC_SEARCH_FULL", "DELETE_FILE", "REAPPLY",
  "RUN_TERMINAL_COMMAND_V2", "FETCH_RULES", "WEB_SEARCH", "MCP", "SEARCH_SYMBOLS",
  "BACKGROUND_COMPOSER_FOLLOWUP", "KNOWLEDGE_BASE", "FETCH_PULL_REQUEST", "DEEP_SEARCH",
  "CREATE_DIAGRAM", "FIX_LINTS", "READ_LINTS", "GO_TO_DEFINITION", "TASK", "AWAIT_TASK",
  "TODO_READ", "TODO_WRITE", "EDIT_FILE_V2", "LIST_DIR_V2", "READ_FILE_V2",
  "RIPGREP_RAW_SEARCH", "GLOB_FILE_SEARCH", "CREATE_PLAN", "LIST_MCP_RESOURCES",
  "READ_MCP_RESOURCE", "READ_PROJECT", "UPDATE_PROJECT", "TASK_V2", "CALL_MCP_TOOL",
  "APPLY_AGENT_DIFF", "ASK_QUESTION", "SWITCH_MODE", "GENERATE_IMAGE", "COMPUTER_USE",
  "WRITE_SHELL_STDIN", "RECORD_SCREEN", "WEB_FETCH", "REPORT_BUGFIX_RESULTS",
  "AI_ATTRIBUTION", "MCP_AUTH", "REFLECT", "AWAIT", "GET_MCP_TOOLS", "SEND_TO_USER",
  "CONNECT_SCM",
] as const);

// Exact `agent.v1.ToolCall.tool` oneof recovered from agent_pb.ts. This is a
// separate union from ClientSideToolV2: a similarly named member is not proof
// that its call/result messages can be converted losslessly.
export const SHIPPED_AGENT_TOOL_CALL_UNION = Object.freeze([
  "shellToolCall", "deleteToolCall", "globToolCall", "grepToolCall", "readToolCall",
  "updateTodosToolCall", "readTodosToolCall", "editToolCall", "lsToolCall",
  "readLintsToolCall", "mcpToolCall", "semSearchToolCall", "createPlanToolCall",
  "webSearchToolCall", "taskToolCall", "listMcpResourcesToolCall",
  "readMcpResourceToolCall", "applyAgentDiffToolCall", "askQuestionToolCall",
  "fetchToolCall", "switchModeToolCall", "generateImageToolCall",
  "recordScreenToolCall", "computerUseToolCall", "writeShellStdinToolCall",
  "reflectToolCall", "setupVmEnvironmentToolCall", "truncatedToolCall",
  "startGrindExecutionToolCall", "startGrindPlanningToolCall", "webFetchToolCall",
  "reportBugfixResultsToolCall", "aiAttributionToolCall", "prManagementToolCall",
  "mcpAuthToolCall", "awaitToolCall", "blameByFilePathToolCall",
  "getMcpToolsToolCall", "reportBugToolCall", "setActiveBranchToolCall",
  "communicateUpdateToolCall", "sendFinalSummaryToolCall", "updatePrCodeTourToolCall",
  "replaceEnvToolCall", "editPrLabelsToolCall", "recordCiInvestigationFindingsToolCall",
  "sendMessageToolCall", "fetchCloudAgentDataToolCall", "sendToUserToolCall",
  "piReadToolCall", "piBashToolCall", "piEditToolCall", "piWriteToolCall",
  "piGrepToolCall", "piFindToolCall", "piLsToolCall", "connectScmToolCall",
  "searchConversationsToolCall", "createGoalToolCall", "updateGoalToolCall",
  "adoptToolCall", "getAgentStatusToolCall", "sendToAgentToolCall",
  "readAgentTranscriptToolCall", "createAgentToolCall", "stopAgentToolCall",
] as const);

/** The oneofs the projection turns into ClientSideToolV2 frames, and the variant each one becomes. */
const SUPPORTED_PROJECTIONS = Object.freeze({
  shellToolCall: "RUN_TERMINAL_COMMAND_V2",
  editToolCall: "EDIT_FILE_V2",
  readToolCall: "READ_FILE_V2 (Read and ExternalRead share this generated agent oneof)",
  mcpToolCall: "CALL_MCP_TOOL",
  taskToolCall: "TASK_V2",
  listMcpResourcesToolCall: "LIST_MCP_RESOURCES",
  readMcpResourceToolCall: "READ_MCP_RESOURCE",
  askQuestionToolCall: "ASK_QUESTION",
  mcpAuthToolCall: "MCP_AUTH",
  webSearchToolCall: "WEB_SEARCH",
  webFetchToolCall: "WEB_FETCH",
  computerUseToolCall: "COMPUTER_USE",
  generateImageToolCall: "GENERATE_IMAGE (the shipped call union has no params arm; rawArgs is preserved)",
  recordScreenToolCall: "RECORD_SCREEN",
  getMcpToolsToolCall: "GET_MCP_TOOLS",
});

/** The oneofs that stay in the ordinary transcript even though the enum has a variant for them. */
const ORDINARY_ONLY_ONEOFS = Object.freeze(["sendMessageToolCall", "awaitToolCall"] as const);

/** The variant name at the head of a projection, before whatever the projection says about it. */
const variantOf = (projection: string): string => projection.split(" (")[0] ?? projection;

/**
 * What is left of the call union: everything that is neither projected nor ordinary-only.
 *
 * Derived rather than listed, so that a oneof added to the shipped union cannot quietly stay out of the inventory —
 * it lands here until somebody decides what it becomes.
 */
export const UNPROJECTED_AGENT_TOOL_CALL_ONEOFS: readonly string[] = Object.freeze(
  SHIPPED_AGENT_TOOL_CALL_UNION.filter((oneof) => !(oneof in SUPPORTED_PROJECTIONS) && !(ORDINARY_ONLY_ONEOFS as readonly string[]).includes(oneof)),
);

/** What is left of the enum's variants, by the same rule: anything the projection cannot produce. */
export const UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS: readonly string[] = Object.freeze(
  SHIPPED_CLIENT_SIDE_TOOL_V2_UNION.filter((variant) => !Object.values(SUPPORTED_PROJECTIONS).some((projection) => variantOf(projection) === variant)),
);

// This inventory is deliberately explicit: absent mappings must remain in the
// ordinary transcript instead of being relabelled as ClientSideToolV2 frames.
export const CLIENT_SIDE_TOOL_V2_PROJECTION_INVENTORY = Object.freeze({
  supported: SUPPORTED_PROJECTIONS,
  ordinaryTranscriptOnly: Object.freeze({
    sendMessageToolCall: "the shipped ClientSideToolV2 enum has no SendMessage variant",
    approvalInteractions: "host permission queries/cards are lifecycle transcript records, not ClientSideToolV2 call/result variants",
    awaitToolCall: "the enum has AWAIT but the shipped call/result unions have no await arms",
  }),
  unrecovered: Object.freeze({
    agentToolOneofs: UNPROJECTED_AGENT_TOOL_CALL_ONEOFS,
    clientSideVariants: UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS,
    policy: "not projected until each agent result can be losslessly matched to a generated ClientSideToolV2 result",
    readBinaryOutputs: "READ_FILE_V2 carries text; binary/blob identifiers remain in ordinary transcript",
  }),
});
