/**
 * What the host hands the runner for one turn, in the shapes the runner's tools expect.
 *
 * Three things live here, and each exists because the host and the runner each own half of something:
 *
 * - **the run step** — the runner's turn engine is what actually produces a step; this file only checks it is bound and
 *   that it produced something callable, so a host built without an engine fails at construction instead of quietly
 *   running a turn that does nothing;
 * - **the toolset host** — the runner's toolset wants live per-turn identity (is this a subagent, is a box attached,
 *   which conversation is this) plus the factories for this turn's props; the host supplies the identities and the
 *   provider supplies the factories, and an identity the host does not have is left out, not faked;
 * - **the tool inputs** — the host's per-turn projections win over what the runner assembled (that is what a projection
 *   is for), and anything neither side has is absent, which is how a tool that cannot work stays unavailable.
 */
import type { HostRunnerHooks, HostRunnerOverrides, HostRunnerSession } from "./host-runner-composition.ts";
import type { SlateAgentRunnerOptions } from "./runner/slate-agent-runner.ts";
import type { BrowserDriverDependencies } from "./runner/tools/slate-browser-tools.ts";
import type { ComputerToolDependencies } from "./runner/tools/slate-computer-tool.ts";
import type { HostShellExecutor } from "./runner/host-computer-tool-dependencies.ts";
import { createTurnToolsetFactoriesForTurn, type TurnToolsetHost, type TurnToolsetHostFactoryProvider, type TurnToolsetTurnInput } from "./runner/tools/turn-toolset.ts";
import type { TurnMcpProjectionInput } from "./runner/turn-agent-composition.ts";
import type { AutoReviewModes } from "./runner/auto-review-gate.ts";
import type { SlateAutoReviewController, SlateAutoReviewExpiryPolicy } from "./runner/slate-auto-review.ts";
import type { SlateAutoReviewInstructions } from "../shared/slate-auto-review-instructions.ts";
import type { AwaitToolOptions } from "../packages/agent/tools/core/await.ts";
import type { WebFetchToolDependencies } from "../adapters/interop/agent/web-fetch-tool-adapter.ts";
import type { WebSearchToolDependencies } from "../packages/agent/tools/core/web-search.ts";
import type { ShellSmartModeApprovalState } from "../packages/agent/tools/core/shell/create-shell-tool.ts";
import type { SmartModeClassifierControls } from "../packages/agent/tools/dev-smart-mode-classifier-block.ts";
import type { CloudAgentApi, CloudAgentToolContext, CloudAgentToolDeps } from "./cloud-agents/cloud-agent-tool.ts";
import type { BackgroundWatchesHost } from "./runner/background-work.ts";
import type { SendMessageDependencies } from "./runner/tools/send-message-tool.ts";
import type { SendToAgentDependencies } from "./runner/tools/slate-agent-management-tools.ts";
import type { ReactToMessageDependencies } from "./runner/tools/slate-reaction-tool.ts";
import type { SlateStateDependencies, SlateStateWriter } from "./runner/tools/slate-state-tool.ts";
import type { McpManagementDependencies } from "./runner/tools/slate-mcp-management-tools.ts";
import type { SubagentManagementController } from "./runner/tools/slate-subagent-management-tools.ts";
import { presentOptions } from "./runner/optional-options.ts";

export type CancelTurnExecution = (reason: { readonly intentional: boolean; readonly reason: string }) => void;

/** A card or update the runner emits for this turn, with the cancellation it is allowed to use. */
export type EmitTurnUpdate = (update: unknown, cancelThisRun: CancelTurnExecution) => void;

export type RunnerStep = NonNullable<SlateAgentRunnerOptions["runStep"]>;

/** Everything the turn engine is given for one step: the session, the host's hooks and overrides, and the tool inputs. */
export interface RunnerStepBuildInput {
  readonly session: HostRunnerSession;
  readonly hooks: HostRunnerHooks;
  readonly overrides: HostRunnerOverrides;
  /** The complete option bag the host assembled for the runner constructor. */
  readonly runnerOptions: Readonly<Record<string, unknown>>;
  /** Creates the per-turn props object the runner's tools are built from. */
  readonly createTurnToolInputs: CreateRunnerToolInputs;
}

/** The runner's turn engine. It is required, so a host cannot substitute a step that does nothing. */
export interface RunnerTurnEngine {
  createRunStep(input: RunnerStepBuildInput): RunnerStep;
}

export type CreateRunnerStep = (input: RunnerStepBuildInput) => RunnerStep;

/** The engine's step, checked once: a missing engine or a step that is not callable is a construction error. */
export function createRunnerStepProvider(engine: RunnerTurnEngine): CreateRunnerStep {
  if (typeof engine?.createRunStep !== "function") throw new TypeError("the production Runner has no turn engine");
  return (input) => {
    const runStep = engine.createRunStep(input);
    if (typeof runStep !== "function") throw new TypeError("the production Runner's turn engine produced no run step");
    return runStep;
  };
}

export interface TurnResourceAccessor {
  get(resource: unknown): unknown;
}

export interface TurnStateHandler {
  readonly [key: string]: unknown;
}

export interface TurnToolSession {
  getExecutor(...args: readonly unknown[]): unknown;
}

export type TurnWebSearchPort = Omit<WebSearchToolDependencies, "resourceAccessor"> & { readonly resourceAccessor?: TurnResourceAccessor };
export type TurnWebFetchPort = Omit<WebFetchToolDependencies, "resourceAccessor"> & { readonly resourceAccessor?: TurnResourceAccessor };

export interface TurnAwaitPort {
  readonly resourceAccessor: TurnResourceAccessor;
  readonly options: AwaitToolOptions;
  readonly promptVersion?: string;
}

export interface TurnAgentConfiguration {
  readonly modelId: string;
  readonly [key: string]: unknown;
}

export interface TurnSummarizer {
  getModelId(): string;
  readonly [key: string]: unknown;
}

export interface TurnModelDescriptor {
  readonly modelName?: string;
  readonly [key: string]: unknown;
}

/** What the runner's tools are built from for one turn. Nothing here is cached across turns. */
export interface RunnerToolInputs {
  readonly resourceAccessor: TurnResourceAccessor;
  readonly stateHandler: TurnStateHandler;
  readonly toolSession: TurnToolSession;
  readonly config: TurnAgentConfiguration;
  readonly summarizationHandler: TurnSummarizer;
  readonly parentModelInfo: TurnModelDescriptor;
  readonly subagentModels: readonly TurnModelDescriptor[];
  readonly subagentConfigs: readonly unknown[];
  readonly fencedToolSet: unknown;
  readonly staticTools: readonly unknown[];
  readonly dynamicTools: readonly unknown[];
  /** WebSearch/WebFetch are built lazily per turn; their factories stay outside. */
  readonly webSearch?: TurnWebSearchPort;
  readonly webFetch?: TurnWebFetchPort;
  /** Awaiting an external event uses this turn's accessor and the terminal's own options. */
  readonly externalAwait?: TurnAwaitPort;
  /** This turn's MCP projection, when MCP is available at all. */
  readonly mcp?: TurnMcpProjectionInput;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun?: CancelTurnExecution;
  /** The two-argument card/update emitter; absent means a card is not emitted at all. */
  readonly emitUpdate?: EmitTurnUpdate;
  readonly createComputerToolDependencies?: (input: RunnerToolInputs) => ComputerToolDependencies<unknown>;
  readonly createScreenshotToolDependencies?: (input: RunnerToolInputs) => ComputerToolDependencies<unknown>;
  readonly createBrowserDriverDependencies?: (input: RunnerToolInputs) => BrowserDriverDependencies<unknown>;
  readonly createBoxShellExecutor?: (input: RunnerToolInputs) => HostShellExecutor;
  readonly hostDependencies?: TurnHostServices;
  readonly turnToolsetFactoryProvider?: TurnToolsetHostFactoryProvider;
}

export type CreateRunnerToolInputs = (input: RunnerToolInputs) => RunnerToolInputs;

export interface TurnToolsetHostBinding {
  readonly turn: TurnToolsetTurnInput;
  readonly props: RunnerToolInputs;
  readonly factoryProvider: TurnToolsetHostFactoryProvider;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isComputerUseSubagent: boolean;
  readonly isBrowserUseSubagent: boolean;
  readonly isSystemPromptOverridden: boolean;
  readonly remoteBoxHasDesktop: boolean;
  readonly getConversationId: () => string;
  readonly getRemoteBoxAvailable: () => boolean;
  readonly cloudAgentsDisabledByTeam: () => boolean;
  readonly spotlightEnabled: () => boolean;
  readonly isDynamicToolsEnabled?: () => boolean;
  readonly isMultitaskEnabled?: () => boolean;
  readonly isSharedRoomBoxToolsEnabled?: () => boolean;
  readonly localToolPermission?: TurnToolsetHost["localToolPermission"];
  readonly recordModelToolName?: TurnToolsetHost["recordModelToolName"];
  readonly toolExecutionTimeoutMs?: TurnToolsetHost["toolExecutionTimeoutMs"];
}

/** The same host built before the Agent has a runtime state handle: the props arrive later. */
export type LazyTurnToolsetHostBinding = Omit<TurnToolsetHostBinding, "props">;

/**
 * The runner's toolset host for one turn. The live identities come from the host and the factories from the provider;
 * a host that has no props yet still gets a host (the lazy form), with no factories, so the tools that need them stay
 * unavailable rather than being replaced by ones that do nothing.
 */
export function createProductionTurnToolsetHost(input: TurnToolsetHostBinding | LazyTurnToolsetHostBinding): TurnToolsetHost {
  const factories = !("props" in input) ? {} : createTurnToolsetFactoriesForTurn(input.factoryProvider, input.turn, input.props);
  return {
    isSubagentRunner: input.isSubagentRunner,
    isSharedRoomRunner: input.isSharedRoomRunner,
    isBoxScopedSubagent: input.isBoxScopedSubagent,
    isComputerUseSubagent: input.isComputerUseSubagent,
    isBrowserUseSubagent: input.isBrowserUseSubagent,
    isSystemPromptOverridden: input.isSystemPromptOverridden,
    remoteBoxHasDesktop: input.remoteBoxHasDesktop,
    getConversationId: input.getConversationId,
    getRemoteBoxAvailable: input.getRemoteBoxAvailable,
    cloudAgentsDisabledByTeam: input.cloudAgentsDisabledByTeam,
    spotlightEnabled: input.spotlightEnabled,
    factoryProvider: input.factoryProvider,
    factories,
    ...presentOptions({
      isDynamicToolsEnabled: input.isDynamicToolsEnabled,
      isMultitaskEnabled: input.isMultitaskEnabled,
      isSharedRoomBoxToolsEnabled: input.isSharedRoomBoxToolsEnabled,
      localToolPermission: input.localToolPermission,
      recordModelToolName: input.recordModelToolName,
      toolExecutionTimeoutMs: input.toolExecutionTimeoutMs,
    }),
  };
}

/** What the host can override on the tool inputs; a projection that is given wins over what the runner assembled. */
export interface TurnHostOverrides {
  readonly webSearch?: RunnerToolInputs["webSearch"];
  readonly webFetch?: RunnerToolInputs["webFetch"];
  readonly externalAwait?: RunnerToolInputs["externalAwait"];
  readonly mcp?: RunnerToolInputs["mcp"];
  readonly ackToken?: RunnerToolInputs["ackToken"];
  readonly cancelThisRun?: RunnerToolInputs["cancelThisRun"];
  readonly emitUpdate?: RunnerToolInputs["emitUpdate"];
  readonly createComputerToolDependencies?: RunnerToolInputs["createComputerToolDependencies"];
  readonly createScreenshotToolDependencies?: RunnerToolInputs["createScreenshotToolDependencies"];
  readonly createBrowserDriverDependencies?: RunnerToolInputs["createBrowserDriverDependencies"];
  readonly createBoxShellExecutor?: RunnerToolInputs["createBoxShellExecutor"];
  readonly hostDependencies?: TurnHostServices;
  readonly turnToolsetFactoryProvider?: TurnToolsetHostFactoryProvider;
}

/**
 * The host-owned inputs for the factory slots the runner builds. Each is a named contract rather than a dictionary, and
 * each is recreated at this boundary per turn.
 */
export interface TurnHostServices {
  readonly isMultitaskEnabled: () => boolean;
  readonly sendMessage: SendMessageDependencies<unknown>;
  readonly sendToAgent: SendToAgentDependencies<unknown>;
  readonly reaction: ReactToMessageDependencies;
  readonly agentManagement: {
    create(profile: { readonly name: string; readonly description: string }): Promise<{ readonly id: string; readonly name: string }>;
    update(agentId: string, patch: { readonly name?: string; readonly description?: string }): Promise<{ readonly id: string; readonly name: string } | null>;
  };
  readonly state?: Pick<SlateStateDependencies, "state" | "automationStore" | "workflowStore" | "parseTrigger" | "reviewAutomationWrite" | "onListenerRoutineSaved"> & { readonly state: SlateStateWriter };
  readonly mcpManagement?: McpManagementDependencies;
  readonly cloudAgent?: {
    readonly api: CloudAgentApi;
    readonly launchedIds: Set<string>;
    readonly agentDir: string;
    readonly readBoxFile?: CloudAgentToolDeps["readBoxFile"];
    readonly writeBoxFile: CloudAgentToolDeps["writeBoxFile"];
    readonly cloudAgentWatcher?: BackgroundWatchesHost["cloudAgentWatcher"];
    readonly watch?: CloudAgentToolDeps["watch"];
    readonly reviewAction?: CloudAgentToolDeps["reviewAction"];
  };
  readonly subagentManagement?: SubagentManagementController<unknown>;
  /**
   * The host's own auto-review identities. What is absent stays absent: a reviewer or classifier context the host does
   * not have is not synthesized here.
   */
  readonly autoReview?: TurnAutoReviewBinding;
}

export interface TurnAutoReviewBinding {
  readonly controller: Pick<SlateAutoReviewController, "requestApproval">;
  /** The session identity shell approvals use; absent keeps those approvals unavailable. */
  readonly agentId?: string;
  readonly getModes: () => AutoReviewModes;
  readonly getInstructions: () => Pick<SlateAutoReviewInstructions, "allowInstructions" | "blockInstructions"> | undefined;
  readonly getApprovalExpiryPolicy: () => SlateAutoReviewExpiryPolicy;
  /** This turn's resolved request context; without it the classifier cannot run. */
  readonly smartModeClassifierControls?: SmartModeClassifierControls;
  readonly getShellApprovalState?: (surface: "host_shell" | "box_shell") => ShellSmartModeApprovalState | undefined;
  readonly enforceModelFacingShellUiAutomationGuard?: boolean;
  readonly actionAuditor?: { record(record: unknown): void };
  readonly localToolPermission?: {
    readonly awaitDesktopStandingDecision: (args: {
      readonly agentId: string;
      readonly toolCallId: string;
      readonly command?: string;
      readonly description?: string;
      readonly signal?: AbortSignal;
    }) => Promise<{ readonly allowed: boolean; readonly reason?: string; readonly approvalId?: string }>;
    readonly completeScope: (scope: { readonly agentId: string; readonly toolCallId: string; readonly directionEpoch?: number; readonly action?: string }) => void;
  };
  readonly platformIsConnected?: (platform: string) => Promise<boolean>;
}

/**
 * This turn's tool inputs, with the host's projections applied over what the runner assembled. A field neither side has
 * is left out entirely, so the tool that would have used it stays unavailable.
 */
export function createRunnerToolInputs(input: RunnerToolInputs, projections?: TurnHostOverrides): RunnerToolInputs {
  return {
    resourceAccessor: input.resourceAccessor,
    stateHandler: input.stateHandler,
    toolSession: input.toolSession,
    config: input.config,
    summarizationHandler: input.summarizationHandler,
    parentModelInfo: input.parentModelInfo,
    subagentModels: input.subagentModels,
    subagentConfigs: input.subagentConfigs,
    fencedToolSet: input.fencedToolSet,
    staticTools: input.staticTools,
    dynamicTools: input.dynamicTools,
    ...presentOptions({
      webSearch: projections?.webSearch ?? input.webSearch,
      webFetch: projections?.webFetch ?? input.webFetch,
      externalAwait: projections?.externalAwait ?? input.externalAwait,
      mcp: projections?.mcp ?? input.mcp,
      ackToken: projections?.ackToken ?? input.ackToken,
      cancelThisRun: projections?.cancelThisRun ?? input.cancelThisRun,
      emitUpdate: projections?.emitUpdate ?? input.emitUpdate,
      createComputerToolDependencies: projections?.createComputerToolDependencies,
      createScreenshotToolDependencies: projections?.createScreenshotToolDependencies,
      createBrowserDriverDependencies: projections?.createBrowserDriverDependencies,
      createBoxShellExecutor: projections?.createBoxShellExecutor,
      hostDependencies: projections?.hostDependencies,
      turnToolsetFactoryProvider: projections?.turnToolsetFactoryProvider,
    }),
  };
}
