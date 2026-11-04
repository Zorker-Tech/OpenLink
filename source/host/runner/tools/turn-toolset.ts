/**
 * The tools one turn may use, and the order they are offered in.
 *
 * `buildTurnTools` is the only door: it decides which tools exist for this turn (a subagent, a shared room, a
 * box-scoped worker, a computer-use worker each get a different set), wraps each one with the identity it needs, and
 * hands back a fenced set. Two rules run through it:
 *
 * - **a tool exists only when its inputs do** — every factory is optional here, and a factory the host did not supply
 *   leaves its tool out rather than substituting one that cannot work (that is how the closed PDF-read branch stays
 *   closed);
 * - **a tool carries the turn's identity** — the conversation it belongs to, the direction epoch of the turn, and the
 *   tool-call name that was recorded for it; the wrappers in this file add exactly that and nothing else.
 *
 * What the file does *not* do is build tools. Each `create*ToolFactory` is a one-line adapter from this module's input
 * contract to the tool's own constructor, so a tool's behaviour stays with the tool.
 */
import { SLATE_HIDDEN_PROMPT_MARKER, SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER } from "../slate-prompt-markers.ts";
import {
  SLATE_BOX_AWAIT_SHELL_TOOL_NAME,
  SLATE_BOX_READ_TOOL_NAME,
  SLATE_BOX_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_READ_TOOL_NAME,
  SLATE_EXTERNAL_SHELL_TOOL_NAME,
} from "../../slate-activity.ts";
import { resolveSlateExternalMachine } from "../../../shared/agents/agent-tool-names.ts";
import { SLATE_REACT_TO_MESSAGE_TOOL_NAME } from "./slate-reaction-tool.ts";
import { SLATE_UPDATE_STATE_TOOL_NAME } from "./slate-state-tool.ts";
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "./send-message-tool.ts";
import { createTaskTool } from "../../../packages/agent/tools/task.ts";
import type { ToolSetHandle } from "../../../packages/agent/tools/tool-execution.ts";
import { slateLocalToolScopeKey, slateTurnDirectionEpochKey } from "../../../shared/local-tool-permission-machinery.ts";
import type { SlateLocalToolAction } from "../../../shared/local-tool-permission.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { ForwardedUpdate } from "../agent-adapters.ts";
import { DynamicToolRegistry, resolveDynamicDispatchToolName } from "../../../packages/agent/tools/mcp/builtin-tools.ts";
import { createCallMcpTool, type CreateCallMcpToolOptions } from "../../../packages/agent/tools/mcp/mcp.ts";
import { createGetMcpToolsTool } from "../../../packages/agent/tools/mcp/get-mcp-tools.ts";
import type { RunnerToolInputs } from "../../runner-production-bridge.ts";
import { SLATE_BOX_WORKSPACE_ROOT } from "../../cloud-agents/cloud-agent-images.ts";
import { slateToolCallExecutionTimeoutMs, wrapDynamicInvocationToolWithTimeout, type McpToolForMeta } from "./mcp-meta-tools.ts";
import { fencedToolSet } from "./slate-spotlight-tools.ts";
import { projectTurnToolsIntoInteropMetaOptions } from "../../../adapters/interop/agent/mcp-meta-tool-options-adapter.ts";
import { createComputerTool, createScreenshotTool, type ComputerToolDependencies } from "./slate-computer-tool.ts";
import { createSlateBrowserTools, type BrowserDriverDependencies } from "./slate-browser-tools.ts";
import { createFileTransferTools, type FileTransferController } from "./slate-file-transfer-tools.ts";
import { createManualHandoffTool, type ManualHandoffPorts } from "./box-help-tool.ts";
import { createGenerateImageTool, type GenerateImageToolDependencies } from "../../../packages/agent/tools/core/generate-image.ts";
import { createWebSearchTool } from "../../../adapters/interop/agent/web-search-tool-adapter.ts";
import type { WebSearchToolDependencies } from "../../../packages/agent/tools/core/web-search.ts";
import { createWebFetchTool, type WebFetchToolDependencies } from "../../../adapters/interop/agent/web-fetch-tool-adapter.ts";
import { createToolCallExecutionTimeoutError } from "../../../packages/agent/tools/tool-support.ts";
import { createAwaitTool, type AwaitToolOptions, type AwaitToolResourceAccessor } from "../../../packages/agent/tools/core/await.ts";
import { createSendMessageTool, type SendMessageDependencies } from "./send-message-tool.ts";
import { createSendToAgentTool, createCreateAgentTool, createUpdateAgentTool, type AgentManagementDependencies, type SendToAgentDependencies } from "./slate-agent-management-tools.ts";
import { createReactToMessageTool, type ReactToMessageDependencies } from "./slate-reaction-tool.ts";
import { createSlateStateTool, type SlateStateDependencies } from "./slate-state-tool.ts";
import { createSubagentManagementTools, type SubagentManagementController } from "./slate-subagent-management-tools.ts";
import { createMcpManagementTools, type McpManagementDependencies } from "./slate-mcp-management-tools.ts";
import { createCloudAgentTool, type CloudAgentToolDeps } from "../../cloud-agents/cloud-agent-tool.ts";
import { createReadTool, type ReadFormattingOptions, type ReadResourceAccessor, type ReadToolOptions } from "../../../packages/agent/tools/core/read/read.ts";
import { createShellTool, type ShellAutoRunInstructions, type ShellToolOptions, type ShellToolResourceAccessor } from "../../../packages/agent/tools/core/shell/create-shell-tool.ts";
import { buildSlateShellAutoReviewTargetEnrichment } from "../slate-shell-auto-review-enrichment.ts";
import { slateShellReadAccessorFromInterop } from "../../../adapters/interop/agent/shell-auto-review-read-adapter.ts";
import { createSlateShellApprovalProvider } from "../slate-auto-review-tool-escalations.ts";
import type { SlateAutoReviewController, SlateAutoReviewExpiryPolicy, SlateAutoReviewMode } from "../slate-auto-review.ts";
import type { SmartModeClassifierControls } from "../../../packages/agent/tools/dev-smart-mode-classifier-block.ts";
import { SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS } from "../slate-auto-review-classifier-run.ts";
import { createSlateMultitaskTodoTool } from "../../slate-multitask.ts";
import { maybeEntry, presentOptions } from "../optional-options.ts";

export const SLATE_EXTERNAL_MACHINE = resolveSlateExternalMachine()!;

export const SLATE_EXTERNAL_READ_TOOL_DESCRIPTION = `Reads a file on ${SLATE_EXTERNAL_MACHINE.label}, the same filesystem ${SLATE_EXTERNAL_SHELL_TOOL_NAME} acts on. That machine is NOT your own computer: it is reached over a connection the user has to approve, so use ${SLATE_BOX_READ_TOOL_NAME} for everything on your own box, including your own files under /home/box.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;
export const SLATE_BOX_READ_TOOL_DESCRIPTION = `Reads a file on your own computer (the box), the same filesystem ${SLATE_BOX_SHELL_TOOL_NAME} and CopyToBox act on. This is your default surface, including your own files under /home/box. Use ${SLATE_EXTERNAL_READ_TOOL_NAME} only for files on ${SLATE_EXTERNAL_MACHINE.label}.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;
export const SLATE_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION = `Reads a file on the box, the same filesystem ${SLATE_BOX_SHELL_TOOL_NAME} acts on.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;

/** What a shared room may offer at all, and the smaller set it may offer when box tools are turned off. */
export const SHARED_ROOM_TOOL_NAMES = new Set([SLATE_SEND_MESSAGE_TOOL_NAME, SLATE_BOX_SHELL_TOOL_NAME, SLATE_BOX_READ_TOOL_NAME, SLATE_BOX_AWAIT_SHELL_TOOL_NAME, "Screenshot"]);
export const SHARED_ROOM_TEXT_ONLY_TOOL_NAMES = new Set([SLATE_SEND_MESSAGE_TOOL_NAME]);

/** Tools that are always placed as static context, whatever their identifier says. */
export const SLATE_FORCED_STATIC_TOOL_NAMES = new Set([SLATE_UPDATE_STATE_TOOL_NAME, SLATE_REACT_TO_MESSAGE_TOOL_NAME]);

/** The one-line hint a dynamic tool gets in static context, by tool identifier. */
export const SLATE_DYNAMIC_TOOL_HINTS: Readonly<Record<string, string>> = {
  CLOUD_AGENT: "Launch and manage Slate cloud coding agents for repository work.",
  SEARCH_PLUGINS: "Search installable plugins/connectors when a task needs a service.",
  AUTHENTICATE_MCP_SERVER: "Start authentication for a connector that needs auth.",
  COPY_TO_BOX: "Copy a file from the user's computer onto your box.",
  COPY_FROM_BOX: "Copy a file from your box onto the user's computer.",
  REQUEST_BOX_HELP: "Hand your box's desktop to the user for a sign-in or manual step.",
  CHECK_SUBAGENT: "Inspect a running background subagent's status and recent actions.",
  MESSAGE_SUBAGENT: "Send a new instruction into a running background subagent.",
  STOP_SUBAGENT: "Abort a running background subagent.",
};

export const SLATE_READ_FORMATTING_OPTIONS = {
  shouldUseFormatCodeblock: false,
  gpt5StyleLineNumbers: false,
  gpt5CodexCatN: false,
  enableLineNumbers: true,
} as const;

export interface ToolExecutionContext {
  readonly directionEpoch?: number;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

export interface ToolMetadata {
  readonly toolCallId: string;
  readonly stateHandler?: unknown;
  readonly workspacePaths?: readonly string[];
}

/** What every tool this file offers looks like: a name, how it is placed, and a way to run it. */
export interface TurnTool {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly id?: string;
  readonly toolIdentifier?: string;
  readonly description?: string;
  readonly contextType?: { readonly type: "static" | "dynamic"; readonly conciseStaticContext?: string };
  readonly dynamicToolMetaRole?: "invocation" | string;
  execute(...args: readonly unknown[]): Promise<unknown>;
}

type TaskToolParameters = Parameters<typeof createTaskTool>;
type TaskToolConfigFactory = TaskToolParameters[1];
type TaskToolConfig = Awaited<ReturnType<TaskToolConfigFactory>>;
type StreamingTurnTool = TurnTool & { execute(context: unknown, interactionHandler: unknown, argumentsStream: AsyncIterable<string>, metadata: unknown): Promise<unknown> };

export type TurnToolsetBuildProps = RunnerToolInputs;

export interface TurnToolsetTurnInput {
  /** The update relay the prepared turn installed, so a card goes out through the same channel as a message. */
  readonly emitUpdate?: (update: ForwardedUpdate) => void;
  readonly remoteBoxResourceAccessor?: RunnerToolInputs["resourceAccessor"];
  readonly subagentConfigs?: TaskToolParameters[4];
  readonly autoReviewModes: ToolFactoryContext["autoReviewModes"];
  readonly stateHandler?: unknown;
  readonly toolSession?: TaskToolConfig["promptSession"];
  readonly config?: TaskToolConfig["agentConfig"];
  readonly summarizationHandler?: TaskToolConfig["summarizationHandler"];
  readonly parentModelInfo?: TaskToolParameters[2];
  readonly subagentModels?: TaskToolParameters[5]["subagentModels"];
  readonly videoReviewAttachedMediaUrlProvider?: unknown;
  readonly cancelThisRun?: (reason: { readonly intentional: boolean; readonly reason: string }) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  /** This turn's MCP descriptors, for the discovery/call pair. */
  readonly mcpTools?: readonly McpToolForMeta[];
  readonly shellAutoReview?: { readonly host?: TurnShellAutoReviewInput; readonly box?: TurnShellAutoReviewInput };
}

export interface TurnShellAutoReviewInput {
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly surface: "host_machine" | "isolated_box";
  readonly smartModeClassifierControls: SmartModeClassifierControls;
  readonly controller?: Pick<SlateAutoReviewController, "requestApproval">;
  readonly getApprovalExpiryPolicy: () => SlateAutoReviewExpiryPolicy;
  readonly smartModeShellApprovalState?: { readonly getIdentity: () => string | undefined; readonly markSideEffectStart: () => void };
  readonly userAutoRunInstructions?: ShellAutoRunInstructions;
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions;
  readonly enforceModelFacingShellUiAutomationGuard: boolean;
}

const shellReviewFor = (autoReview: NonNullable<RunnerToolInputs["hostDependencies"]>["autoReview"], mode: SlateAutoReviewMode, surface: TurnShellAutoReviewInput["surface"], approvalSurface: "host_shell" | "box_shell"): TurnShellAutoReviewInput | undefined => {
  if (autoReview === undefined || mode === "off") return undefined;
  const smartModeClassifierControls = autoReview.smartModeClassifierControls!;
  const agentId = autoReview.agentId!;
  const instructions = autoReview.getInstructions();
  const modes = autoReview.getModes();
  return {
    mode,
    agentId,
    surface,
    smartModeClassifierControls,
    controller: autoReview.controller,
    getApprovalExpiryPolicy: autoReview.getApprovalExpiryPolicy,
    ...presentOptions({
      smartModeShellApprovalState: autoReview.getShellApprovalState?.(approvalSurface),
      userAutoRunInstructions:
        instructions === undefined
          ? undefined
          : { allowInstructions: instructions.allowInstructions, blockInstructions: instructions.blockInstructions },
    }),
    enforceModelFacingShellUiAutomationGuard:
      autoReview.enforceModelFacingShellUiAutomationGuard ?? (modes.hostShell === "enforce" || modes.computer === "enforce"),
  };
};

/**
 * The shell review identities for this turn. What the turn states explicitly wins; otherwise the host's own
 * projection is used, and a projection without a request context or an agent identity produces no Smart Mode options
 * at all rather than synthetically bound ones.
 */
export function resolveTurnShellAutoReviewInputs(turn: TurnToolsetTurnInput, props: TurnToolsetBuildProps): TurnToolsetTurnInput["shellAutoReview"] {
  if (turn.shellAutoReview !== undefined) return turn.shellAutoReview;
  const autoReview = props.hostDependencies?.autoReview;
  // Without classifier controls and an agent identity there is nothing a Smart Mode review could be bound to, so the turn
  // gets no Smart Mode options at all rather than synthetic ones.
  if (autoReview === undefined || autoReview.smartModeClassifierControls === undefined || autoReview.agentId === undefined) return undefined;
  const modes = autoReview.getModes();
  const host = shellReviewFor(autoReview, modes.hostShell, "host_machine", "host_shell");
  const box = shellReviewFor(autoReview, modes.boxShell, "isolated_box", "box_shell");
  if (host === undefined && box === undefined) return undefined;
  return { ...maybeEntry(host, (value) => ({ host: value })), ...maybeEntry(box, (value) => ({ box: value })) };
}

/** The shell tool's options with this turn's review identities folded in; no review means the options unchanged. */
export function createTurnShellAutoReviewOptions(input: { readonly resourceAccessor: ShellToolResourceAccessor; readonly options: ShellToolOptions; readonly review?: TurnShellAutoReviewInput }): ShellToolOptions {
  const { review } = input;
  if (review === undefined) return input.options;
  return {
    ...input.options,
    smartModeClassifierControls: review.smartModeClassifierControls,
    smartModeClassifierMode: review.mode === "enforce",
    smartModeClassifierShadowMode: review.mode === "shadow",
    smartModeApprovalSurface: review.surface,
    smartModeShellTargetEnrichmentProvider: (context, args) =>
      buildSlateShellAutoReviewTargetEnrichment(context, {
        resourceAccessor: slateShellReadAccessorFromInterop(args.resourceAccessor),
        command: args.command,
        toolCallId: args.toolCallId,
        ...presentOptions({ workingDirectory: args.workingDirectory }),
      }),
    smartModeClassifierMaxAttempts: SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
    suppressSmartModeClassifierTelemetryIds: true,
    loadSmartModeWorkspacePermissionFiles: false,
    disableSmartModeAllowlistPrecheck: true,
    enforceModelFacingShellUiAutomationGuard: review.enforceModelFacingShellUiAutomationGuard,
    ...presentOptions({
      smartModeApprovalProvider:
        review.controller === undefined || review.mode !== "enforce"
          ? undefined
          : createSlateShellApprovalProvider({
              controller: review.controller,
              agentId: review.agentId,
              surface: review.surface === "host_machine" ? "host_shell" : "box_shell",
              getExpiryPolicy: review.getApprovalExpiryPolicy,
            }),
      smartModeShellApprovalState: review.smartModeShellApprovalState,
      userAutoRunInstructions: review.userAutoRunInstructions,
      projectAutoRunInstructions: review.projectAutoRunInstructions,
    }),
  };
}

export interface LocalToolPermission {
  completeScope(scope: { agentId: string; toolCallId: string; directionEpoch?: number; action?: string }): void;
}

/** Where a tool is offered: forced static, hinted static, or dynamic — the hint is what static context shows. */
export function withDynamicToolPlacement<T extends TurnTool>(tool: T): T {
  if (SLATE_FORCED_STATIC_TOOL_NAMES.has(tool.name)) return { ...tool, contextType: { type: "static" } };
  if (tool.contextType !== undefined || tool.toolIdentifier === undefined) return tool;
  const hint = SLATE_DYNAMIC_TOOL_HINTS[tool.toolIdentifier];
  if (hint === undefined) return tool;
  return { ...tool, contextType: { type: "dynamic", conciseStaticContext: hint } };
}

/** A tool call carries the scope it ran under, so the permission gate sees the same identity the tool did. */
export function withLocalToolScope<T extends TurnTool>(tool: T, agentId: string, permission: LocalToolPermission | undefined, action?: SlateLocalToolAction): T {
  if (permission === undefined) return tool;
  return {
    ...tool,
    async execute(context: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, metadata: ToolMetadata) {
      const directionEpoch = context.get(slateTurnDirectionEpochKey);
      const scope = {
        agentId,
        toolCallId: metadata.toolCallId,
        ...presentOptions({ directionEpoch, action }),
      };
      try {
        return await tool.execute(context.with(slateLocalToolScopeKey, scope), interactionHandler, argsStream, metadata);
      } finally {
        // The scope is completed whether the tool returned or threw: a permission prompt must not stay open.
        permission.completeScope(scope);
      }
    },
  };
}

/** The tool-call name the model chose is recorded before the tool runs, which is what the UI shows it as. */
export function withRecordedToolCallNames<T extends TurnTool>(tool: T, record: (toolCallId: string, toolName: string) => void): T {
  return {
    ...tool,
    execute(...args: readonly unknown[]) {
      const metadata = args.at(-1);
      if (typeof metadata !== "object" || metadata === null || !("toolCallId" in metadata) || typeof metadata.toolCallId !== "string") {
        throw new TypeError("tool call metadata is not bound");
      }
      record(metadata.toolCallId, tool.name);
      return tool.execute(...args);
    },
  };
}

/** A tool call that runs past its ceiling is failed with the timeout error the platform reports, not left hanging. */
export function withToolTimeout<T extends TurnTool>(
  tool: T,
  timeoutMs: number,
  createTimeoutError: () => Error = () => createToolCallExecutionTimeoutError({ toolName: tool.name, executionTimeoutMs: timeoutMs }),
): T {
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          tool.execute(...args),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(createTimeoutError()), timeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

export interface ToolFactoryContext {
  readonly autoReviewModes: {
    readonly hostShell: string;
    readonly boxShell: string;
    readonly mcp: string;
    readonly computer: string;
    readonly automationWrite: string;
    readonly cloudAgent: string;
    readonly subagentLaunch: string;
  };
  readonly stateHandler?: unknown;
}

/** Every tool this turn could offer; a missing key means that tool is not available at all. */
export interface TurnToolFactories {
  task?(): TurnTool;
  multitask?(): TurnTool;
  sendMessage?(): TurnTool;
  sendToAgent?(): TurnTool;
  reaction?(): TurnTool;
  createAgent?(): TurnTool;
  updateAgent?(): TurnTool;
  updateState?(): TurnTool;
  externalShell?(): TurnTool | undefined;
  externalRead?(): TurnTool;
  externalAwait?(): TurnTool;
  webSearch?(): TurnTool;
  webFetch?(): TurnTool;
  generateImage?(): TurnTool;
  cloudAgent?(): TurnTool;
  boxShell?(): TurnTool | undefined;
  boxRead?(): TurnTool;
  boxAwait?(): TurnTool;
  fileTransfer?(): readonly TurnTool[];
  computer?(): TurnTool;
  browser?(): readonly TurnTool[];
  screenshot?(): TurnTool;
  requestBoxHelp?(): TurnTool;
  mcpMeta?(dynamicToolRegistry?: DynamicToolRegistry): readonly TurnTool[];
  mcpManagement?(): readonly TurnTool[];
  subagentManagement?(): readonly TurnTool[];
}

export type TurnTaskToolParameters = Parameters<typeof createTaskTool>;

/** What the shipped Task constructor needs, kept exact so no generic factory bag can lose the resource/session identity. */
export interface TurnTaskToolFactoryInput {
  readonly resourceAccessor: TurnTaskToolParameters[0];
  readonly getTaskToolConfig: TurnTaskToolParameters[1];
  readonly parentModelInfo: TurnTaskToolParameters[2];
  readonly stateHandler: TurnTaskToolParameters[3];
  readonly subagentConfigs: TurnTaskToolParameters[4];
  readonly options: TurnTaskToolParameters[5];
}

export interface TurnMultitaskToolFactoryInput {
  readonly resourceAccessor: Parameters<typeof createSlateMultitaskTodoTool>[0];
  readonly stateHandler: Parameters<typeof createSlateMultitaskTodoTool>[1];
}

export interface TurnMcpMetaToolFactoryInput {
  readonly resourceAccessor: TaskToolParameters[0];
  readonly getMcpTools: () => readonly McpToolForMeta[];
  readonly callOptions: Omit<CreateCallMcpToolOptions, "resourceAccessor" | "mcpMetaToolOptions" | "dynamicToolRegistry">;
  readonly discoveryOptions?: {
    readonly projectDir?: string;
    readonly allowInteractiveMcpAuth?: boolean;
    readonly isMcpToolBlocked?: CreateCallMcpToolOptions["isMcpToolBlocked"];
  };
}

export interface TurnComputerToolFactoryInput {
  readonly dependencies: ComputerToolDependencies<unknown>;
}

export interface TurnBrowserToolFactoryInput {
  readonly dependencies: BrowserDriverDependencies<unknown>;
}

export interface TurnFileTransferToolFactoryInput {
  readonly controller: FileTransferController;
}

export interface TurnBoxHelpToolFactoryInput {
  readonly dependencies: ManualHandoffPorts;
}

export interface TurnGenerateImageToolFactoryInput {
  readonly dependencies: GenerateImageToolDependencies;
}

export interface TurnWebSearchToolFactoryInput {
  readonly dependencies: WebSearchToolDependencies;
}

export interface TurnWebFetchToolFactoryInput {
  readonly dependencies: WebFetchToolDependencies;
}

export interface TurnAwaitToolFactoryInput {
  readonly resourceAccessor: AwaitToolResourceAccessor;
  readonly options: AwaitToolOptions;
  readonly promptVersion?: string;
}

export interface TurnShellToolFactoryInput {
  /** The accessor this turn uses to reach the shell stream executor. */
  readonly resourceAccessor: ShellToolResourceAccessor;
  readonly options?: ShellToolOptions;
}

export interface TurnReadToolFactoryInput {
  readonly resourceAccessor: ReadResourceAccessor;
  readonly formattingOptions: ReadFormattingOptions;
  readonly promptVersion?: string;
  readonly options?: ReadToolOptions;
}

export interface TurnSendMessageToolFactoryInput {
  readonly dependencies: SendMessageDependencies<Context>;
}

export interface TurnSendToAgentToolFactoryInput {
  readonly dependencies: SendToAgentDependencies<unknown>;
}

export interface TurnReactionToolFactoryInput {
  readonly dependencies: ReactToMessageDependencies;
}

export interface TurnAgentManagementToolFactoryInput {
  readonly dependencies: AgentManagementDependencies;
}

export interface TurnStateToolFactoryInput {
  readonly dependencies: SlateStateDependencies;
}

export interface TurnSubagentManagementToolFactoryInput {
  readonly controller: SubagentManagementController<unknown>;
}

export interface TurnMcpManagementToolFactoryInput {
  readonly management: McpManagementDependencies;
  readonly getRequestingAgentId?: Parameters<typeof createMcpManagementTools>[1];
  readonly isAwaitingUserSelection?: Parameters<typeof createMcpManagementTools>[2];
  readonly isMultiAccountEnabled?: Parameters<typeof createMcpManagementTools>[3];
  readonly emitConnectorCard?: Parameters<typeof createMcpManagementTools>[4];
}

export interface TurnCloudAgentToolFactoryInput {
  readonly dependencies: CloudAgentToolDeps;
}

export interface TurnToolsetFactoryInputs {
  readonly task?: TurnTaskToolFactoryInput;
  readonly multitask?: TurnMultitaskToolFactoryInput;
  readonly mcpMeta?: TurnMcpMetaToolFactoryInput;
  readonly computer?: TurnComputerToolFactoryInput;
  readonly browser?: TurnBrowserToolFactoryInput;
  readonly screenshot?: TurnComputerToolFactoryInput;
  readonly fileTransfer?: TurnFileTransferToolFactoryInput;
  readonly requestBoxHelp?: TurnBoxHelpToolFactoryInput;
  readonly generateImage?: TurnGenerateImageToolFactoryInput;
  readonly webSearch?: TurnWebSearchToolFactoryInput;
  readonly webFetch?: TurnWebFetchToolFactoryInput;
  readonly externalAwait?: TurnAwaitToolFactoryInput;
  readonly boxAwait?: TurnAwaitToolFactoryInput;
  readonly externalShell?: TurnShellToolFactoryInput;
  readonly externalRead?: TurnReadToolFactoryInput;
  readonly boxShell?: TurnShellToolFactoryInput;
  readonly boxRead?: TurnReadToolFactoryInput;
  readonly sendMessage?: TurnSendMessageToolFactoryInput;
  readonly sendToAgent?: TurnSendToAgentToolFactoryInput;
  readonly reaction?: TurnReactionToolFactoryInput;
  readonly agentManagement?: TurnAgentManagementToolFactoryInput;
  readonly state?: TurnStateToolFactoryInput;
  readonly subagentManagement?: TurnSubagentManagementToolFactoryInput;
  readonly mcpManagement?: TurnMcpManagementToolFactoryInput;
  readonly cloudAgent?: TurnCloudAgentToolFactoryInput;
}

/** How the host projects one tool's inputs for this turn, freshly, per tool. */
type FactoryInputsProvider<Input> = (turn: TurnToolsetTurnInput, props: TurnToolsetBuildProps) => Input;

/** The host half of the toolset: one projection per tool, each optional so an absent tool stays absent. */
export interface TurnToolsetHostFactoryProvider {
  readonly createTaskToolInputs?: FactoryInputsProvider<TurnTaskToolFactoryInput>;
  readonly createMultitaskToolInputs?: FactoryInputsProvider<TurnMultitaskToolFactoryInput>;
  readonly createMcpMetaToolInputs?: FactoryInputsProvider<TurnMcpMetaToolFactoryInput>;
  readonly createComputerToolInputs?: FactoryInputsProvider<TurnComputerToolFactoryInput>;
  readonly createBrowserToolInputs?: FactoryInputsProvider<TurnBrowserToolFactoryInput>;
  readonly createScreenshotToolInputs?: FactoryInputsProvider<TurnComputerToolFactoryInput>;
  readonly createFileTransferToolInputs?: FactoryInputsProvider<TurnFileTransferToolFactoryInput>;
  readonly createRequestBoxHelpToolInputs?: FactoryInputsProvider<TurnBoxHelpToolFactoryInput>;
  readonly createGenerateImageToolInputs?: FactoryInputsProvider<TurnGenerateImageToolFactoryInput>;
  readonly createWebSearchToolInputs?: FactoryInputsProvider<TurnWebSearchToolFactoryInput>;
  readonly createWebFetchToolInputs?: FactoryInputsProvider<TurnWebFetchToolFactoryInput>;
  readonly createExternalAwaitToolInputs?: FactoryInputsProvider<TurnAwaitToolFactoryInput>;
  readonly createBoxAwaitToolInputs?: FactoryInputsProvider<TurnAwaitToolFactoryInput>;
  readonly createExternalShellToolInputs?: FactoryInputsProvider<TurnShellToolFactoryInput | undefined>;
  readonly createExternalReadToolInputs?: FactoryInputsProvider<TurnReadToolFactoryInput | undefined>;
  readonly createBoxShellToolInputs?: FactoryInputsProvider<TurnShellToolFactoryInput | undefined>;
  readonly createBoxReadToolInputs?: FactoryInputsProvider<TurnReadToolFactoryInput | undefined>;
  readonly createSendMessageToolInputs?: FactoryInputsProvider<TurnSendMessageToolFactoryInput>;
  readonly createSendToAgentToolInputs?: FactoryInputsProvider<TurnSendToAgentToolFactoryInput>;
  readonly createReactionToolInputs?: FactoryInputsProvider<TurnReactionToolFactoryInput>;
  readonly createAgentManagementToolInputs?: FactoryInputsProvider<TurnAgentManagementToolFactoryInput>;
  readonly createStateToolInputs?: FactoryInputsProvider<TurnStateToolFactoryInput>;
  readonly createSubagentManagementToolInputs?: FactoryInputsProvider<TurnSubagentManagementToolFactoryInput>;
  readonly createMcpManagementToolInputs?: FactoryInputsProvider<TurnMcpManagementToolFactoryInput>;
  readonly createCloudAgentToolInputs?: FactoryInputsProvider<TurnCloudAgentToolFactoryInput>;
}

/** A tool a factory returned is checked once, so a broken factory fails here rather than somewhere in a turn. */
function asTurnTool<T extends object>(value: T): T & TurnTool {
  if (typeof Reflect.get(value, "name") !== "string" || typeof Reflect.get(value, "execute") !== "function") {
    throw new TypeError("turn tool factory returned an invalid tool");
  }
  return value as T & TurnTool;
}

export function createTurnTaskToolFactory(input: TurnTaskToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createTaskTool(input.resourceAccessor, input.getTaskToolConfig, input.parentModelInfo, input.stateHandler, input.subagentConfigs, input.options));
}

export function createTurnMultitaskToolFactory(input: TurnMultitaskToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createSlateMultitaskTodoTool(input.resourceAccessor, input.stateHandler));
}

/** The MCP discovery/call pair: the catalog is read per build, and the registry is the one placement produced. */
export function createTurnMcpMetaToolFactory(input: TurnMcpMetaToolFactoryInput): (dynamicToolRegistry?: DynamicToolRegistry) => readonly TurnTool[] {
  return (dynamicToolRegistry) => {
    const mcpMetaToolOptions = projectTurnToolsIntoInteropMetaOptions(input.getMcpTools());
    const discovery = createGetMcpToolsTool(mcpMetaToolOptions, {
      resourceAccessor: input.resourceAccessor,
      ...presentOptions({
        projectDir: input.discoveryOptions?.projectDir,
        allowInteractiveMcpAuth: input.discoveryOptions?.allowInteractiveMcpAuth,
        isMcpToolBlocked: input.discoveryOptions?.isMcpToolBlocked,
        dynamicToolRegistry,
      }),
    });
    const call = createCallMcpTool({
      ...input.callOptions,
      resourceAccessor: input.resourceAccessor,
      mcpMetaToolOptions,
      ...presentOptions({ dynamicToolRegistry }),
    });
    return [asTurnTool(discovery), asTurnTool(call)];
  };
}

export function createTurnComputerToolFactory(input: TurnComputerToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createComputerTool(input.dependencies));
}

export function createTurnScreenshotToolFactory(input: TurnComputerToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createScreenshotTool(input.dependencies));
}

export function createTurnBrowserToolFactory(input: TurnBrowserToolFactoryInput): () => readonly TurnTool[] {
  return () => createSlateBrowserTools(input.dependencies).map(asTurnTool);
}

export function createTurnFileTransferToolFactory(input: TurnFileTransferToolFactoryInput): () => readonly TurnTool[] {
  return () => createFileTransferTools(input.controller).map(asTurnTool);
}

export function createTurnBoxHelpToolFactory(input: TurnBoxHelpToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createManualHandoffTool(input.dependencies));
}

export function createTurnGenerateImageToolFactory(input: TurnGenerateImageToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createGenerateImageTool(input.dependencies));
}

export function createTurnWebSearchToolFactory(input: TurnWebSearchToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createWebSearchTool(input.dependencies));
}

export function createTurnWebFetchToolFactory(input: TurnWebFetchToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createWebFetchTool(input.dependencies));
}

export function createTurnAwaitToolFactory(input: TurnAwaitToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createAwaitTool(input.resourceAccessor, input.options, input.promptVersion));
}

export function createTurnShellToolFactory(input: TurnShellToolFactoryInput): () => TurnTool | undefined {
  return () => {
    const tool = createShellTool(input.resourceAccessor, input.options);
    return tool === undefined ? undefined : asTurnTool(tool);
  };
}

export function createTurnReadToolFactory(input: TurnReadToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createReadTool(input.resourceAccessor, input.formattingOptions, input.promptVersion, input.options));
}

export function createTurnSendMessageToolFactory(input: TurnSendMessageToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createSendMessageTool(input.dependencies));
}

export function createTurnSendToAgentToolFactory(input: TurnSendToAgentToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createSendToAgentTool(input.dependencies));
}

export function createTurnReactionToolFactory(input: TurnReactionToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createReactToMessageTool(input.dependencies));
}

export function createTurnCreateAgentToolFactory(input: TurnAgentManagementToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createCreateAgentTool(input.dependencies));
}

export function createTurnUpdateAgentToolFactory(input: TurnAgentManagementToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createUpdateAgentTool(input.dependencies));
}

export function createTurnStateToolFactory(input: TurnStateToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createSlateStateTool(input.dependencies));
}

export function createTurnSubagentManagementToolFactory(input: TurnSubagentManagementToolFactoryInput): () => readonly TurnTool[] {
  return () => createSubagentManagementTools(input.controller).map(asTurnTool);
}

export function createTurnMcpManagementToolFactory(input: TurnMcpManagementToolFactoryInput): () => readonly TurnTool[] {
  return () =>
    createMcpManagementTools(input.management, input.getRequestingAgentId, input.isAwaitingUserSelection, input.isMultiAccountEnabled, input.emitConnectorCard).map(asTurnTool);
}

export function createTurnCloudAgentToolFactory(input: TurnCloudAgentToolFactoryInput): () => TurnTool {
  return () => asTurnTool(createCloudAgentTool(input.dependencies));
}

type BuiltToolFactories = Pick<
  TurnToolFactories,
  | "task"
  | "multitask"
  | "mcpMeta"
  | "computer"
  | "browser"
  | "screenshot"
  | "fileTransfer"
  | "requestBoxHelp"
  | "generateImage"
  | "webSearch"
  | "webFetch"
  | "externalAwait"
  | "boxAwait"
  | "externalShell"
  | "externalRead"
  | "boxShell"
  | "boxRead"
  | "sendMessage"
  | "sendToAgent"
  | "reaction"
  | "createAgent"
  | "updateAgent"
  | "updateState"
  | "subagentManagement"
  | "mcpManagement"
  | "cloudAgent"
>;

/** The factories for the inputs that exist: one entry per tool, and an input the host did not give adds nothing. */
export function createTurnToolsetFactories(input: TurnToolsetFactoryInputs): BuiltToolFactories {
  const factories: Record<string, unknown> = {};
  if (input.task !== undefined) factories.task = createTurnTaskToolFactory(input.task);
  if (input.multitask !== undefined) factories.multitask = createTurnMultitaskToolFactory(input.multitask);
  if (input.mcpMeta !== undefined) factories.mcpMeta = createTurnMcpMetaToolFactory(input.mcpMeta);
  if (input.computer !== undefined) factories.computer = createTurnComputerToolFactory(input.computer);
  if (input.browser !== undefined) factories.browser = createTurnBrowserToolFactory(input.browser);
  if (input.screenshot !== undefined) factories.screenshot = createTurnScreenshotToolFactory(input.screenshot);
  if (input.fileTransfer !== undefined) factories.fileTransfer = createTurnFileTransferToolFactory(input.fileTransfer);
  if (input.requestBoxHelp !== undefined) factories.requestBoxHelp = createTurnBoxHelpToolFactory(input.requestBoxHelp);
  if (input.generateImage !== undefined) factories.generateImage = createTurnGenerateImageToolFactory(input.generateImage);
  if (input.webSearch !== undefined) factories.webSearch = createTurnWebSearchToolFactory(input.webSearch);
  if (input.webFetch !== undefined) factories.webFetch = createTurnWebFetchToolFactory(input.webFetch);
  if (input.externalAwait !== undefined) factories.externalAwait = createTurnAwaitToolFactory(input.externalAwait);
  if (input.boxAwait !== undefined) factories.boxAwait = createTurnAwaitToolFactory(input.boxAwait);
  if (input.externalShell !== undefined) factories.externalShell = createTurnShellToolFactory(input.externalShell);
  if (input.externalRead !== undefined) factories.externalRead = createTurnReadToolFactory(input.externalRead);
  if (input.boxShell !== undefined) factories.boxShell = createTurnShellToolFactory(input.boxShell);
  if (input.boxRead !== undefined) factories.boxRead = createTurnReadToolFactory(input.boxRead);
  if (input.sendMessage !== undefined) factories.sendMessage = createTurnSendMessageToolFactory(input.sendMessage);
  if (input.sendToAgent !== undefined) factories.sendToAgent = createTurnSendToAgentToolFactory(input.sendToAgent);
  if (input.reaction !== undefined) factories.reaction = createTurnReactionToolFactory(input.reaction);
  if (input.agentManagement !== undefined) {
    factories.createAgent = createTurnCreateAgentToolFactory(input.agentManagement);
    factories.updateAgent = createTurnUpdateAgentToolFactory(input.agentManagement);
  }
  if (input.state !== undefined) factories.updateState = createTurnStateToolFactory(input.state);
  if (input.subagentManagement !== undefined) factories.subagentManagement = createTurnSubagentManagementToolFactory(input.subagentManagement);
  if (input.mcpManagement !== undefined) factories.mcpManagement = createTurnMcpManagementToolFactory(input.mcpManagement);
  if (input.cloudAgent !== undefined) factories.cloudAgent = createTurnCloudAgentToolFactory(input.cloudAgent);
  return factories as BuiltToolFactories;
}

/**
 * The same factories from the host's per-turn projections: each projection is asked for its inputs, and one that yields
 * nothing (the shell and read tools do that when their resource is closed) adds nothing.
 */
export function createTurnToolsetFactoriesForTurn(provider: TurnToolsetHostFactoryProvider, turn: TurnToolsetTurnInput, props: TurnToolsetBuildProps): BuiltToolFactories {
  const inputs: Record<string, unknown> = {};
  const projection = (key: string, value: unknown): void => {
    if (value !== undefined) inputs[key] = value;
  };
  projection("task", provider.createTaskToolInputs?.(turn, props));
  projection("multitask", provider.createMultitaskToolInputs?.(turn, props));
  projection("mcpMeta", provider.createMcpMetaToolInputs?.(turn, props));
  projection("computer", provider.createComputerToolInputs?.(turn, props));
  projection("browser", provider.createBrowserToolInputs?.(turn, props));
  projection("screenshot", provider.createScreenshotToolInputs?.(turn, props));
  projection("fileTransfer", provider.createFileTransferToolInputs?.(turn, props));
  projection("requestBoxHelp", provider.createRequestBoxHelpToolInputs?.(turn, props));
  projection("generateImage", provider.createGenerateImageToolInputs?.(turn, props));
  projection("webSearch", provider.createWebSearchToolInputs?.(turn, props));
  projection("webFetch", provider.createWebFetchToolInputs?.(turn, props));
  projection("externalAwait", provider.createExternalAwaitToolInputs?.(turn, props));
  projection("boxAwait", provider.createBoxAwaitToolInputs?.(turn, props));
  projection("externalShell", provider.createExternalShellToolInputs?.(turn, props));
  projection("externalRead", provider.createExternalReadToolInputs?.(turn, props));
  projection("boxShell", provider.createBoxShellToolInputs?.(turn, props));
  projection("boxRead", provider.createBoxReadToolInputs?.(turn, props));
  projection("sendMessage", provider.createSendMessageToolInputs?.(turn, props));
  projection("sendToAgent", provider.createSendToAgentToolInputs?.(turn, props));
  projection("reaction", provider.createReactionToolInputs?.(turn, props));
  projection("agentManagement", provider.createAgentManagementToolInputs?.(turn, props));
  projection("state", provider.createStateToolInputs?.(turn, props));
  projection("subagentManagement", provider.createSubagentManagementToolInputs?.(turn, props));
  projection("mcpManagement", provider.createMcpManagementToolInputs?.(turn, props));
  projection("cloudAgent", provider.createCloudAgentToolInputs?.(turn, props));
  return createTurnToolsetFactories(inputs as TurnToolsetFactoryInputs);
}

export interface TurnToolsetHost {
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isComputerUseSubagent: boolean;
  readonly isBrowserUseSubagent: boolean;
  readonly isSystemPromptOverridden: boolean;
  readonly remoteBoxHasDesktop: boolean;
  readonly localToolPermission?: LocalToolPermission;
  getConversationId(): string;
  getRemoteBoxAvailable(): boolean;
  cloudAgentsDisabledByTeam(): boolean;
  spotlightEnabled(): boolean;
  isDynamicToolsEnabled?(): boolean;
  isMultitaskEnabled?(): boolean;
  isSharedRoomBoxToolsEnabled?(): boolean;
  recordModelToolName?(toolCallId: string, name: string): void;
  toolExecutionTimeoutMs?(toolName: string): number;
  /** The base provider; the lazy tools boundary projects it with runtime props, so construction needs no state handle. */
  factoryProvider?: TurnToolsetHostFactoryProvider;
  factories: TurnToolFactories;
}

export type TurnToolsetInput = TurnToolsetTurnInput;

/** What the auto-review classifier is allowed to see: everything except the prompts the platform hides. */
export function extractSlateAutoReviewClassifierContext(messages: readonly { readonly role: string; readonly content: string }[]): readonly { readonly role: string; readonly content: string }[] {
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    if (message.content.startsWith(`${SLATE_HIDDEN_PROMPT_MARKER}${SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER}`)) return true;
    return !message.content.startsWith(SLATE_HIDDEN_PROMPT_MARKER);
  });
}

/**
 * The tools this turn gets, in the order they are offered.
 *
 * The order is the same for every turn; what changes is which branches are open. Each branch asks one question — is this
 * a subagent, is the prompt overridden, is a box attached, does this worker own a desktop — and an offer that produces
 * no tool adds nothing.
 */
export function buildTurnTools(host: TurnToolsetHost, turn: TurnToolsetInput, props?: TurnToolsetBuildProps): ToolSetHandle {
  const offered: TurnTool[] = [];
  const offer = (tool: TurnTool | undefined): void => {
    if (tool !== undefined) offered.push(tool);
  };
  const offerAll = (tools: readonly TurnTool[] | undefined): void => {
    if (tools !== undefined) offered.push(...tools);
  };

  // A subagent that is neither computer-use nor browser-use and has no subagent configs gets nothing to call: this is
  // the fenced worker the platform runs without tools.
  if (host.isSubagentRunner && (host.isComputerUseSubagent || host.isBrowserUseSubagent) === false && turn.subagentConfigs === undefined) {
    return fencedToolSet([], host.spotlightEnabled());
  }

  const dynamicToolsEnabled = !host.isSubagentRunner && !host.isSharedRoomRunner && !host.isBoxScopedSubagent && host.isDynamicToolsEnabled?.() === true;
  const dynamicToolRegistry = dynamicToolsEnabled ? new DynamicToolRegistry() : undefined;
  const dynamicInvocationRegistry =
    dynamicToolRegistry === undefined
      ? undefined
      : { resolveToolName: (rawArguments: string): string | undefined => resolveDynamicDispatchToolName(rawArguments, dynamicToolRegistry) };
  const factories = host.factories;

  if (!host.isSubagentRunner && !host.isSharedRoomRunner && turn.subagentConfigs != null) {
    offer(props === undefined ? factories.task?.() : createTurnTaskToolFactory(taskFactoryInputFor(props, turn, host))());
  }
  if (!host.isSubagentRunner && !host.isSystemPromptOverridden && host.isMultitaskEnabled?.() === true) offer(factories.multitask?.());
  if (!host.isSubagentRunner) {
    offer(factories.sendMessage?.());
    offer(factories.sendToAgent?.());
    offer(factories.reaction?.());
    offer(factories.createAgent?.());
    offer(factories.updateAgent?.());
    if (!host.isSystemPromptOverridden) offer(factories.updateState?.());
  }

  const agentId = host.getConversationId();
  /** Every tool that acts on the machine carries the call's scope and the name the model chose for it. */
  const scoped = (tool: TurnTool | undefined, action?: SlateLocalToolAction): TurnTool | undefined =>
    tool == null
      ? undefined
      : withLocalToolScope(
          withRecordedToolCallNames(tool, (toolCallId, name) => host.recordModelToolName?.(toolCallId, name)),
          agentId,
          host.localToolPermission,
          action,
        );

  if (!host.isBoxScopedSubagent) {
    offer(scoped(factories.externalShell?.(), "run-command"));
    offer(scoped(factories.externalRead?.(), "read-file"));
    offer(scoped(factories.externalAwait?.(), "read-file"));
    offer(factories.webSearch?.());
    offer(factories.webFetch?.());
  }
  if (!host.isSubagentRunner) offer(factories.generateImage?.());
  if (!host.isBoxScopedSubagent && !host.cloudAgentsDisabledByTeam()) offer(factories.cloudAgent?.());

  if (host.getRemoteBoxAvailable()) {
    offer(scoped(factories.boxShell?.()));
    offer(scoped(factories.boxRead?.()));
    if (!host.isBoxScopedSubagent) {
      offer(scoped(factories.boxAwait?.()));
      const fileTransfer = factories.fileTransfer?.();
      if (fileTransfer !== undefined) offerAll(fileTransfer.map((tool) => withLocalToolScope(tool, agentId, host.localToolPermission)));
    }
  }
  if (host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) offer(factories.computer?.());
  if (host.isBrowserUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) offerAll(factories.browser?.());
  if (!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {
    offer(factories.screenshot?.());
    offer(factories.requestBoxHelp?.());
  }

  // A factory alone is not an MCP service: the discovery/call pair is offered only when this turn really has an MCP
  // projection, or when dynamic mode owns the registry.
  if (!host.isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)) offerAll(factories.mcpMeta?.(dynamicToolRegistry));
  if (!host.isSubagentRunner) {
    offerAll(factories.mcpManagement?.());
    if (turn.subagentConfigs != null) {
      const subagentManagement =
        factories.subagentManagement?.() ??
        (props?.hostDependencies?.subagentManagement === undefined
          ? undefined
          : createTurnSubagentManagementToolFactory({ controller: props.hostDependencies.subagentManagement })());
      offerAll(subagentManagement);
    }
  }

  const sharedRoomAllowed = host.isSharedRoomRunner
    ? host.isSharedRoomBoxToolsEnabled?.() === false
      ? SHARED_ROOM_TEXT_ONLY_TOOL_NAMES
      : SHARED_ROOM_TOOL_NAMES
    : undefined;
  const accessible = sharedRoomAllowed == null ? offered : offered.filter((tool) => sharedRoomAllowed.has(tool.name));
  const placed = dynamicToolsEnabled ? accessible.map(withDynamicToolPlacement) : accessible;
  const guarded = placed.map((tool) => {
    if (dynamicInvocationRegistry !== undefined && tool.dynamicToolMetaRole === "invocation") {
      return wrapDynamicInvocationToolWithTimeout(tool as StreamingTurnTool, dynamicInvocationRegistry, host.isComputerUseSubagent) as unknown as TurnTool;
    }
    const executionTimeoutMs = slateToolCallExecutionTimeoutMs(tool.name, host.isComputerUseSubagent);
    return withToolTimeout(tool, executionTimeoutMs, () => createToolCallExecutionTimeoutError({ toolName: tool.name, executionTimeoutMs }));
  });
  return fencedToolSet(guarded, host.spotlightEnabled(), dynamicToolRegistry);
}

/**
 * The Task tool's inputs when this turn has runtime props: the subagent's own tools are fenced, it cannot reach a shell
 * or pick a model, and it only inherits the parent's model when the platform allows it.
 */
function taskFactoryInputFor(props: TurnToolsetBuildProps, turn: TurnToolsetTurnInput, host: TurnToolsetHost): TurnTaskToolFactoryInput {
  return {
    resourceAccessor: props.resourceAccessor as TaskToolParameters[0],
    getTaskToolConfig: async () => ({
      agentConfig: { ...props.config, toolsGenerator: () => fencedToolSet([], host.spotlightEnabled()) },
      promptSession: props.toolSession,
      summarizationHandler: props.summarizationHandler,
    }),
    parentModelInfo: props.parentModelInfo as TaskToolParameters[2],
    stateHandler: props.stateHandler as unknown as TaskToolParameters[3],
    subagentConfigs: turn.subagentConfigs!,
    options: {
      readonlyShellEnabled: false,
      allowCustomModelId: false,
      includeExploreSubagent: false,
      subagentModels: props.subagentModels,
      requireServerSideSubagent: false,
      compareModelCosts: () => 0,
      isModelBlocked: () => false,
      isModelValid: () => true,
      useClientSideSubagent: true,
      enableExploreParentModelInheritance: true,
      enableJobCompletionNotifications: true,
      videoReviewAttachedMediaUrlProvider: turn.videoReviewAttachedMediaUrlProvider,
      enableAgentChatLinks: false,
      trustedVideoAttachmentRoots: host.remoteBoxHasDesktop ? [SLATE_BOX_WORKSPACE_ROOT] : [],
    } as unknown as TaskToolParameters[5],
  };
}
