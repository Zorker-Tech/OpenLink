/** What a tool call looks like to the surface the user sees it in.
 *
 * A call the agent made is projected into the platform's own tool surface — the command it runs, the file it edits, the
 * file it reads — with what it was given, what it answered and what it failed with, so the surface shows the platform's
 * tools rather than the agent's wire shapes. The projection is one table keyed by the agent's tool oneof: an entry says
 * how the call is shown while it runs and how its answer is shown once it has run, and a tool with no entry stays in the
 * ordinary transcript.
 */
import type { ToolCall } from "../../packages/proto/generated/agent/v1/agent_pb.ts";
import { GenerateImageResult } from "../../packages/proto/generated/agent/v1/generate_image_tool_pb.ts";
import { RecordScreenArgs, RecordScreenResult } from "../../packages/proto/generated/agent/v1/record_screen_exec_pb.ts";
import { Struct } from "@bufbuild/protobuf";
import {
  AskQuestionParams,
  AskQuestionParams_Option,
  AskQuestionParams_Question,
  AskQuestionResult,
  AskQuestionResult_Answer,
  CallMcpToolParams,
  CallMcpToolResult,
  ClientSideToolV2,
  ClientSideToolV2Call,
  ClientSideToolV2Result,
  ComputerUseParams,
  ComputerUseResult,
  EditFileResult_FileDiff,
  EditFileResult_FileDiff_ChunkDiff,
  EditFileV2Params,
  EditFileV2Result,
  GetMcpToolsParams,
  GetMcpToolsResult,
  ListMcpResourcesParams,
  ListMcpResourcesResult,
  ListMcpResourcesResult_MCPResource,
  McpAuthParams,
  McpAuthResult,
  ReadFileV2Params,
  ReadFileV2Result,
  ReadMcpResourceParams,
  ReadMcpResourceResult,
  RunTerminalCommandEndedReason,
  RunTerminalCommandV2Params,
  RunTerminalCommandV2Result,
  TaskV2Params,
  TaskV2Result,
  ToolResultError,
  WebFetchParams,
  WebFetchResult,
  WebSearchParams,
  WebSearchResult,
  WebSearchResult_WebReference,
} from "../../packages/proto/generated/aiserver/v1/tools_pb.ts";

// The oneofs the surface has were recovered from the shipped generated tools region; only the tool calls whose fields
// can be projected without inventing data are here. A tool the generation has and the surface does not keeps its
// ordinary transcript record instead of being relabelled as one of this platform's tools.

export type ProjectedClientSideToolV2 =
  | { readonly kind: "call"; readonly value: ClientSideToolV2Call }
  | { readonly kind: "result"; readonly value: ClientSideToolV2Result };

/** A tool call as the agent sends it: the generated shapes differ per tool, and only the shown fields are read. */
type RecordValue = Record<string, any>;

/** What a tool answered: the result oneof the agent sent for that tool. Both arms are present when there is an answer. */
interface ToolOutcome {
  readonly case: string;
  readonly value: RecordValue;
}

/** What the projection knows about a call besides the tool record itself. */
interface CallContext {
  readonly callId: string;
  readonly modelCallId: string;
  readonly surfaceName: string;
  readonly isStreaming: boolean;
}

/** A call as the surface shows it before the tool has answered. */
interface CallShape {
  readonly tool: ClientSideToolV2;
  readonly name: string;
  readonly rawArgs: RecordValue;
  readonly params?: ClientSideToolV2Call["params"];
}

/** One tool's projection: the call while it runs, and the answer once it has run. */
interface ToolProjection {
  readonly started: (args: RecordValue | undefined, context: CallContext) => ProjectedClientSideToolV2 | null;
  readonly completed: (record: RecordValue, context: CallContext) => ProjectedClientSideToolV2 | null;
}

/** What a successful answer becomes: the result to show, or why it cannot be shown as one. */
type SuccessfulAnswer = { readonly result: ClientSideToolV2Result["result"] } | { readonly error: string };

/** The words the surface uses when a tool only says that it failed, or where the showable answer is not the answer. */
const TOOL_FAILED = "Tool failed: ";
const EDIT_FAILED = "Edit failed: ";
const PERMISSION_DENIED = "Permission denied: ";
const COMMAND_NOT_STARTED = "Command could not be started";
const READ_AS_BYTES = "Read completed with non-text content; bytes remain available in ordinary transcript transport";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The answer a tool record carries, when it carries one at all: the tool's generated result message holds the oneof. */
const outcomeOf = (record: RecordValue): ToolOutcome | null => {
  const carried = record.result as { result?: { case?: string; value?: RecordValue } } | undefined;
  const outcome = carried?.result;
  if (outcome?.case == null || outcome.value == null) return null;
  return { case: outcome.case, value: outcome.value };
};

/** What a tool said when it did not answer. */
const failureOf = (outcome: ToolOutcome): string => {
  const value = outcome.value ?? {};
  const said = text(value.errorMessage ?? value.error ?? value.reason);
  return said === "" ? `${TOOL_FAILED}${outcome.case}` : said;
};

/** A failed answer: the same words for the user and for the model. */
const failed = (tool: ClientSideToolV2, context: CallContext, message: string): ProjectedClientSideToolV2 => ({
  kind: "result",
  value: new ClientSideToolV2Result({
    tool,
    toolCallId: context.callId,
    error: new ToolResultError({ clientVisibleErrorMessage: message, modelVisibleErrorMessage: message }),
  }),
});

/** An answer that produced what the surface shows. */
const answered = (tool: ClientSideToolV2, context: CallContext, result: ClientSideToolV2Result["result"]): ProjectedClientSideToolV2 => ({
  kind: "result",
  value: new ClientSideToolV2Result({ tool, toolCallId: context.callId, result }),
});

/** A call as the surface shows it before the tool answers: the arguments as they came, and the typed shape of them. */
const callFrame = (context: CallContext, shape: CallShape): ProjectedClientSideToolV2 => ({
  kind: "call",
  value: new ClientSideToolV2Call({
    tool: shape.tool,
    toolCallId: context.callId,
    name: shape.name,
    rawArgs: JSON.stringify(shape.rawArgs),
    isStreaming: context.isStreaming,
    ...(context.modelCallId ? { modelCallId: context.modelCallId } : {}),
    ...(shape.params === undefined ? {} : { params: shape.params }),
  }),
});

/** The projection of a tool whose answer only means something when it reported success. */
const answersOnSuccess = (
  tool: ClientSideToolV2,
  build: (value: RecordValue, record: RecordValue) => SuccessfulAnswer,
): ToolProjection["completed"] => (record, context) => {
  const outcome = outcomeOf(record);
  if (outcome === null) return null;
  if (outcome.case !== "success") return failed(tool, context, failureOf(outcome));
  const answer = build(outcome.value ?? {}, record);
  return "error" in answer ? failed(tool, context, answer.error) : answered(tool, context, answer.result);
};

/** The projection of a tool whose whole answer is carried by the generated message for it. */
const wrapsAnswer = (
  tool: ClientSideToolV2,
  wrap: (value: RecordValue) => ClientSideToolV2Result["result"],
): ToolProjection["completed"] => (record, context) => {
  if (record.result == null) return null;
  return answered(tool, context, wrap(record.result as RecordValue));
};

/** What the shell printed: what it interleaved, or its two streams in order when it said nothing interleaved. */
const commandOutput = (value: RecordValue): string => {
  const interleaved = text(value.interleavedOutput);
  return interleaved === "" ? [text(value.stdout), text(value.stderr)].filter(Boolean).join("\n") : interleaved;
};

/** How a shell run ended, by what the agent reported and, for a plain failure, whether the user stopped it. */
const shellEnding = (outcome: ToolOutcome, value: RecordValue): RunTerminalCommandEndedReason => {
  switch (outcome.case) {
    case "success": return RunTerminalCommandEndedReason.EXECUTION_COMPLETED;
    case "rejected": return RunTerminalCommandEndedReason.UNSPECIFIED;
    case "timeout": return RunTerminalCommandEndedReason.IDLE_TIMEOUT;
    default: return value.aborted === true ? RunTerminalCommandEndedReason.EXECUTION_ABORTED : RunTerminalCommandEndedReason.EXECUTION_FAILED;
  }
};

const startedShell: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  const command = text(args.command);
  if (command.length === 0) return null;
  const workingDirectory = text(args.workingDirectory);
  return callFrame(context, {
    tool: ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
    name: context.surfaceName || "Shell",
    // The surface shows the command and where it runs, not every switch the agent sent.
    rawArgs: { command: args.command, cwd: args.workingDirectory },
    params: {
      case: "runTerminalCommandV2Params",
      value: new RunTerminalCommandV2Params({
        command,
        ...(workingDirectory.length === 0 ? {} : { cwd: workingDirectory }),
        isBackground: args.isBackground === true,
        requireUserApproval: args.skipApproval !== true,
      }),
    },
  });
};

const completedShell: ToolProjection["completed"] = (record, context) => {
  const outcome = outcomeOf(record);
  if (outcome === null) return null;
  const value = outcome.value ?? {};
  if (outcome.case === "permissionDenied") return failed(ClientSideToolV2.RUN_TERMINAL_COMMAND_V2, context, `${PERMISSION_DENIED}${text(value.reason ?? value.error)}`);
  if (outcome.case === "spawnError") return failed(ClientSideToolV2.RUN_TERMINAL_COMMAND_V2, context, text(value.error) || COMMAND_NOT_STARTED);
  const output = commandOutput(value);
  const hasExitCode = typeof value.exitCode === "number";
  const background = (record.result as RecordValue).isBackground === true;
  return answered(ClientSideToolV2.RUN_TERMINAL_COMMAND_V2, context, {
    case: "runTerminalCommandV2Result",
    value: new RunTerminalCommandV2Result({
      output,
      outputRaw: output,
      exitCode: hasExitCode ? value.exitCode : 0,
      ...(hasExitCode ? { exitCodeV2: value.exitCode } : {}),
      ...(outcome.case === "rejected" ? { rejected: true } : {}),
      poppedOutIntoBackground: background,
      isRunningInBackground: background,
      resultingWorkingDirectory: text(value.workingDirectory),
      endedReason: shellEnding(outcome, value),
    }),
  });
};

const startedEdit: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  const path = text(args.path);
  if (path.length === 0) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.EDIT_FILE_V2,
    name: "Edit",
    rawArgs: { path: args.path },
    params: {
      case: "editFileV2Params",
      value: new EditFileV2Params({
        relativeWorkspacePath: path,
        ...(typeof args.streamContent === "string" ? { streamingContent: args.streamContent } : {}),
      }),
    },
  });
};

const editDiff = (diffString: string): EditFileResult_FileDiff | undefined =>
  diffString.length === 0 ? undefined : new EditFileResult_FileDiff({ chunks: [new EditFileResult_FileDiff_ChunkDiff({ diffString })] });

const completedEdit: ToolProjection["completed"] = (record, context) => {
  const outcome = outcomeOf(record);
  if (outcome === null) return null;
  const value = outcome.value ?? {};
  if (outcome.case !== "success" && outcome.case !== "rejected") {
    const said = text(value.error ?? value.reason) || `${EDIT_FAILED}${outcome.case}`;
    const message = outcome.case.includes("PermissionDenied") ? `${PERMISSION_DENIED}${said}` : said;
    return failed(ClientSideToolV2.EDIT_FILE_V2, context, message);
  }
  const diff = editDiff(text(value.diffString));
  return answered(ClientSideToolV2.EDIT_FILE_V2, context, {
    case: "editFileV2Result",
    value: new EditFileV2Result({
      fileWasCreated: value.beforeFullFileContent == null,
      ...(typeof value.beforeFullFileContent === "string" ? { contentsBeforeEdit: value.beforeFullFileContent } : {}),
      ...(typeof value.afterFullFileContent === "string" ? { contentsAfterEdit: value.afterFullFileContent } : {}),
      ...(diff === undefined ? {} : { diff }),
      ...(outcome.case === "rejected" ? { rejected: true } : {}),
      resultForModel: text(value.message ?? value.reason),
    }),
  });
};

const startedRead: ToolProjection["started"] = (args, context) => {
  if (args == null || text(args.path).length === 0) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.READ_FILE_V2,
    name: context.surfaceName || "Read",
    rawArgs: args,
    params: {
      case: "readFileV2Params",
      value: new ReadFileV2Params({ targetFile: text(args.path), offset: args.offset, limit: args.limit, enableLineNumbers: args.includeLineNumbers }),
    },
  });
};

const completedRead = answersOnSuccess(ClientSideToolV2.READ_FILE_V2, (value) => {
  const output = value.output as RecordValue | undefined;
  // Bytes stay in the ordinary transcript; this surface only shows text.
  if (output?.case !== "content") return { error: READ_AS_BYTES };
  const contents = text(output.value);
  return {
    result: {
      case: "readFileV2Result",
      value: new ReadFileV2Result({ contents, numCharactersInRequestedRange: contents.length, totalLinesInFile: Number(value.totalLines ?? 0) }),
    },
  };
});

const startedMcp: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  const toolName = text(args.toolName ?? args.name);
  if (toolName.length === 0) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.CALL_MCP_TOOL,
    name: text(args.name) || "MCP",
    rawArgs: args,
    params: {
      case: "callMcpToolParams",
      value: new CallMcpToolParams({
        server: text(args.serverIdentifier ?? args.providerIdentifier),
        toolName,
        toolArgs: new Struct({ fields: args.args ?? {} }),
      }),
    },
  });
};

const completedMcp = answersOnSuccess(ClientSideToolV2.CALL_MCP_TOOL, (value, record) => {
  const args = (record.args ?? {}) as RecordValue;
  const structured = value.structuredContent instanceof Struct
    ? value.structuredContent
    : Struct.fromJson({ content: Array.isArray(value.content) ? value.content.map((item: any) => item.toJson?.() ?? item) : [], isError: value.isError === true });
  return {
    result: {
      case: "callMcpToolResult",
      value: new CallMcpToolResult({ server: text(args.serverIdentifier), toolName: text(args.toolName ?? args.name), result: structured }),
    },
  };
});

const startedTask: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  const prompt = text(args.prompt);
  if (prompt.length === 0) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.TASK_V2,
    name: "Task",
    rawArgs: args,
    params: {
      case: "taskV2Params",
      value: new TaskV2Params({
        description: text(args.description),
        prompt,
        subagentType: text(args.subagentType),
        model: args.model,
        name: text(args.description),
        mode: Number(args.mode ?? 0) as any,
      }),
    },
  });
};

const completedTask = answersOnSuccess(ClientSideToolV2.TASK_V2, (value, record) => ({
  result: {
    case: "taskV2Result",
    value: new TaskV2Result({ agentId: value.agentId, isBackground: value.isBackground === true, cloudAgentBcId: record.cloudAgentBcId }),
  },
}));

const startedListMcpResources: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.LIST_MCP_RESOURCES,
    name: "ListMcpResources",
    rawArgs: args,
    params: { case: "listMcpResourcesParams", value: new ListMcpResourcesParams({ server: args.server }) },
  });
};

const completedListMcpResources = answersOnSuccess(ClientSideToolV2.LIST_MCP_RESOURCES, (value) => ({
  result: {
    case: "listMcpResourcesResult",
    value: new ListMcpResourcesResult({ resources: (value.resources ?? []).map((resource: any) => new ListMcpResourcesResult_MCPResource(resource)) }),
  },
}));

const startedReadMcpResource: ToolProjection["started"] = (args, context) => {
  if (args == null || !text(args.server) || !text(args.uri)) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.READ_MCP_RESOURCE,
    name: "ReadMcpResource",
    rawArgs: args,
    params: {
      case: "readMcpResourceParams",
      value: new ReadMcpResourceParams({ server: text(args.server), uri: text(args.uri), downloadPath: args.downloadPath }),
    },
  });
};

const completedReadMcpResource = answersOnSuccess(ClientSideToolV2.READ_MCP_RESOURCE, (value) => ({
  result: { case: "readMcpResourceResult", value: new ReadMcpResourceResult(value as any) },
}));

const startedAskQuestion: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  const questions = (args.questions ?? []).map((question: any) => new AskQuestionParams_Question({
    id: text(question.id),
    prompt: text(question.prompt),
    allowMultiple: question.allowMultiple === true,
    options: (question.options ?? []).map((option: any) => new AskQuestionParams_Option({ id: text(option.id), label: text(option.label) })),
  }));
  return callFrame(context, {
    tool: ClientSideToolV2.ASK_QUESTION,
    name: "AskQuestion",
    rawArgs: args,
    params: { case: "askQuestionParams", value: new AskQuestionParams({ title: text(args.title), questions, runAsync: args.runAsync === true }) },
  });
};

const completedAskQuestion: ToolProjection["completed"] = (record, context) => {
  const outcome = outcomeOf(record);
  if (outcome === null) return null;
  if (outcome.case === "error" || outcome.case === "rejected") return failed(ClientSideToolV2.ASK_QUESTION, context, failureOf(outcome));
  const answers = (outcome.value.answers ?? []).map((answer: any) => new AskQuestionResult_Answer({
    questionId: text(answer.questionId),
    selectedOptionIds: answer.selectedOptionIds ?? [],
    freeformText: answer.freeformText,
  }));
  return answered(ClientSideToolV2.ASK_QUESTION, context, {
    case: "askQuestionResult",
    value: new AskQuestionResult({ isAsync: outcome.case === "async", answers }),
  });
};

const startedMcpAuth: ToolProjection["started"] = (args, context) => {
  if (args == null || !text(args.serverIdentifier)) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.MCP_AUTH,
    name: "McpAuth",
    rawArgs: args,
    params: { case: "mcpAuthParams", value: new McpAuthParams({ serverIdentifier: text(args.serverIdentifier) }) },
  });
};

const completedMcpAuth = answersOnSuccess(ClientSideToolV2.MCP_AUTH, (value) => ({
  result: { case: "mcpAuthResult", value: new McpAuthResult({ success: true, message: text(value.serverIdentifier) }) },
}));

const startedWebSearch: ToolProjection["started"] = (args, context) => {
  if (args == null || !text(args.searchTerm)) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.WEB_SEARCH,
    name: "WebSearch",
    rawArgs: args,
    params: { case: "webSearchParams", value: new WebSearchParams({ searchTerm: text(args.searchTerm) }) },
  });
};

const completedWebSearch: ToolProjection["completed"] = (record, context) => {
  const outcome = outcomeOf(record);
  if (outcome === null) return null;
  if (outcome.case === "error") return failed(ClientSideToolV2.WEB_SEARCH, context, failureOf(outcome));
  const references = (outcome.value.references ?? []).map((reference: any) => new WebSearchResult_WebReference(reference));
  return answered(ClientSideToolV2.WEB_SEARCH, context, {
    case: "webSearchResult",
    value: new WebSearchResult({ rejected: outcome.case === "rejected", isFinal: true, references }),
  });
};

const startedWebFetch: ToolProjection["started"] = (args, context) => {
  if (args == null || !text(args.url)) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.WEB_FETCH,
    name: "WebFetch",
    rawArgs: args,
    params: { case: "webFetchParams", value: new WebFetchParams({ url: text(args.url) }) },
  });
};

const completedWebFetch: ToolProjection["completed"] = (record, context) => {
  const outcome = outcomeOf(record);
  if (outcome === null) return null;
  const value = outcome.value;
  const args = record.args as RecordValue | undefined;
  return answered(ClientSideToolV2.WEB_FETCH, context, {
    case: "webFetchResult",
    value: new WebFetchResult({
      url: text(value.url ?? args?.url),
      ...(outcome.case === "success" ? { markdown: text(value.markdown) } : { error: failureOf(outcome) }),
    }),
  });
};

const startedComputerUse: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.COMPUTER_USE,
    name: "Computer",
    rawArgs: args,
    params: { case: "computerUseParams", value: new ComputerUseParams({ actions: args.actions ?? [] }) },
  });
};

const startedGenerateImage: ToolProjection["started"] = (args, context) => {
  if (args == null || !text(args.description)) return null;
  return callFrame(context, { tool: ClientSideToolV2.GENERATE_IMAGE, name: "GenerateImage", rawArgs: args });
};

const startedRecordScreen: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.RECORD_SCREEN,
    name: "RecordScreen",
    rawArgs: args,
    params: { case: "recordScreenParams", value: new RecordScreenArgs(args as any) },
  });
};

const startedGetMcpTools: ToolProjection["started"] = (args, context) => {
  if (args == null) return null;
  return callFrame(context, {
    tool: ClientSideToolV2.GET_MCP_TOOLS,
    name: "GetMcpTools",
    rawArgs: args,
    params: { case: "getMcpToolsParams", value: new GetMcpToolsParams({ server: args.server, toolName: args.toolName, pattern: args.pattern }) },
  });
};

const completedGetMcpTools = answersOnSuccess(ClientSideToolV2.GET_MCP_TOOLS, (value) => ({
  result: {
    case: "getMcpToolsResult",
    value: new GetMcpToolsResult({ content: text(value.content), outputFilePath: value.outputFilePath }),
  },
}));

/**
 * The tools this surface has, by the agent's name for each oneof.
 *
 * A tool oneof with no entry is not projected at all: it keeps its ordinary transcript record. Adding a tool to the
 * surface is one entry here, and both the call it shows while running and the answer it shows afterwards come from the
 * same entry.
 */
const PROJECTIONS: ReadonlyMap<string, ToolProjection> = new Map<string, ToolProjection>([
  ["shellToolCall", { started: startedShell, completed: completedShell }],
  ["editToolCall", { started: startedEdit, completed: completedEdit }],
  ["readToolCall", { started: startedRead, completed: completedRead }],
  ["mcpToolCall", { started: startedMcp, completed: completedMcp }],
  ["taskToolCall", { started: startedTask, completed: completedTask }],
  ["listMcpResourcesToolCall", { started: startedListMcpResources, completed: completedListMcpResources }],
  ["readMcpResourceToolCall", { started: startedReadMcpResource, completed: completedReadMcpResource }],
  ["askQuestionToolCall", { started: startedAskQuestion, completed: completedAskQuestion }],
  ["mcpAuthToolCall", { started: startedMcpAuth, completed: completedMcpAuth }],
  ["webSearchToolCall", { started: startedWebSearch, completed: completedWebSearch }],
  ["webFetchToolCall", { started: startedWebFetch, completed: completedWebFetch }],
  ["computerUseToolCall", { started: startedComputerUse, completed: wrapsAnswer(ClientSideToolV2.COMPUTER_USE, (value) => ({ case: "computerUseResult", value: new ComputerUseResult(value as any) })) }],
  ["generateImageToolCall", { started: startedGenerateImage, completed: wrapsAnswer(ClientSideToolV2.GENERATE_IMAGE, (value) => ({ case: "generateImageResult", value: new GenerateImageResult(value as any) })) }],
  ["recordScreenToolCall", { started: startedRecordScreen, completed: wrapsAnswer(ClientSideToolV2.RECORD_SCREEN, (value) => ({ case: "recordScreenResult", value: new RecordScreenResult(value as any) })) }],
  ["getMcpToolsToolCall", { started: startedGetMcpTools, completed: completedGetMcpTools }],
]);

/**
 * Projects one agent tool call into the platform's own tool surface, when the surface has that tool.
 *
 * A call is shown while it runs and again once the tool has answered; a tool with no projection, or a call with no id,
 * is not shown. The surface's own name for a tool stands in when the caller has none.
 */
export function projectAgentToolCallToClientSideToolV2(
  phase: "toolCallStarted" | "partialToolCall" | "toolCallCompleted",
  callId: string,
  toolCall: ToolCall,
  modelCallId = "",
  surfaceName = "",
): ProjectedClientSideToolV2 | null {
  if (callId.length === 0) return null;
  const projection = PROJECTIONS.get(toolCall.tool.case ?? "");
  if (projection === undefined) return null;
  const record = toolCall.tool.value as unknown as RecordValue;
  const args = record.args as RecordValue | undefined;
  const context: CallContext = { callId, modelCallId, surfaceName, isStreaming: phase === "partialToolCall" };
  return phase === "toolCallCompleted" ? projection.completed(record, context) : projection.started(args, context);
}
