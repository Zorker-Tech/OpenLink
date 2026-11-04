/**
 * What the computer tool needs from the host.
 *
 * The box's desktop, its monitor, its approvals and the shell behind them are gathered here, so the tool asks for one
 * dependency object rather than reaching into the host for each piece. Three projections come out of this module:
 * the computer-use executor, the shell executor that carries the host's approval and audit rules, and the browser
 * driver's identity and shell bridge.
 */
import { computerUseExecutorFromResource, type ComputerUseExecutorPort } from "../../adapters/interop/agent/computer-use-executor-adapter.ts";
import { createHostBoxShellExecutor, type HostShellResult } from "../../adapters/interop/agent/box-shell-executor-adapter.ts";
import type { ExecutorOptions } from "../../packages/agent-exec/executor-resources.ts";
import type { HostShellArgsInput } from "../boxes/box-shell-command.ts";
import type {
  ComputerProtocolAction,
  ComputerToolDependencies,
  ComputerUseResult,
  ReportedComputerAction,
} from "./tools/slate-computer-tool.ts";
import type { BrowserDriverDependencies } from "./tools/slate-browser-tools.ts";
import type { SlateBrowserAutoReviewOptions } from "./slate-browser-auto-review.ts";
import type { SlateComputerAutoReviewOptions } from "./slate-computer-auto-review.ts";

/** What the host hands the computer tool: the resource accessor and the optional hooks around it. */
export type HostComputerToolProjectionInput<Context = unknown> = {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly persistImage?: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<{ readonly fileUrl: string } | undefined>;
  readonly isUnicodeTypingEnabled?: () => boolean;
  readonly onComputerAction?: (action: ReportedComputerAction) => void;
  readonly autoReview?: SlateComputerAutoReviewOptions;
};

/** What the host hands its shell projection: the resource accessor plus the two safety callbacks. */
export type HostShellExecutorProjectionInput = {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly assertNoPendingApproval: () => void;
  readonly auditShellCommand: (command: string) => void;
};

/** The shell the browser driver executes through. */
export interface HostShellExecutor {
  execute(
    context: unknown,
    toolArgs: HostShellArgsInput,
    options?: ExecutorOptions,
  ): Promise<HostShellResult>;
}

/** The box a browser driver drives: its readiness, its window per agent, and its file transfers. */
export type HostBrowserBoxOwner<Context = unknown> = {
  ensureReady(context: Context, agentId: string): Promise<unknown>;
  getAgentWindowIndex(agentId: string): number | undefined;
  uploadFile(context: Context, agentId: string, path: string, bytes: Uint8Array): Promise<void>;
  downloadFile(context: Context, agentId: string, path: string): Promise<Uint8Array>;
};

/** What the host hands the browser driver: its box, its identities and the shell it runs commands through. */
export type HostBrowserDriverProjectionInput<Context = unknown> = {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly box: HostBrowserBoxOwner<Context>;
  readonly getBoxId: () => string;
  readonly getDefaultViewId: () => string;
  readonly executeShell: HostShellExecutor;
  readonly getPersistImage?: BrowserDriverDependencies<Context>["getPersistImage"];
  readonly autoReview?: SlateBrowserAutoReviewOptions;
};

/** The computer-use executor a turn's resource accessor carries, projected through the protocol adapter. */
function carriedComputerUseExecutor(resourceAccessor: { get(resource: unknown): unknown }): ComputerUseExecutorPort {
  return computerUseExecutorFromResource(resourceAccessor);
}

/** Run one computer-use request through the turn's executor. */
async function runComputerUse(
  executor: ComputerUseExecutorPort,
  context: unknown,
  toolArgs: Parameters<ComputerToolDependencies["execute"]>[1],
): Promise<ComputerUseResult> {
  return await executor.execute(context, toolArgs);
}

/** The computer tool's dependencies, projected from the turn's executor and the caller's hooks. */
export function createHostComputerToolDependencies<Context = unknown>(
  hostInput: HostComputerToolProjectionInput<Context>,
): ComputerToolDependencies<Context> {
  const executor = carriedComputerUseExecutor(hostInput.resourceAccessor);
  return {
    resourceAccessor: hostInput.resourceAccessor,
    async execute(context, toolArgs) {
      return runComputerUse(executor, context, toolArgs);
    },
    getPersistImage: () => hostInput.persistImage,
    ...(hostInput.isUnicodeTypingEnabled === undefined ? {} : { isUnicodeTypingEnabled: hostInput.isUnicodeTypingEnabled }),
    ...(hostInput.onComputerAction === undefined ? {} : { onComputerAction: hostInput.onComputerAction }),
    ...(hostInput.autoReview === undefined ? {} : { autoReview: hostInput.autoReview }),
  };
}

/** The shell executor a turn's resource accessor carries, projected through the protocol adapter. */
function carriedShellExecutor(resourceAccessor: { get(resource: unknown): unknown }): ReturnType<typeof createHostBoxShellExecutor> {
  return createHostBoxShellExecutor(resourceAccessor);
}

/** Run one shell request after the host's approval and audit rules have seen it. */
async function shellThrough(
  executor: ReturnType<typeof createHostBoxShellExecutor>,
  guards: HostShellExecutorProjectionInput,
  context: unknown,
  toolArgs: HostShellArgsInput,
  options?: ExecutorOptions,
): Promise<HostShellResult> {
  guards.assertNoPendingApproval();
  guards.auditShellCommand(toolArgs.command);
  return await executor.execute(context, toolArgs, options);
}

/**
 * Projects the real box shell resource without inventing approval or audit behavior. Both safety callbacks are
 * mandatory and run before the generated executor receives the caller's context and abort-bearing options.
 */
export function createHostShellExecutor(hostInput: HostShellExecutorProjectionInput): HostShellExecutor {
  const executor = carriedShellExecutor(hostInput.resourceAccessor);
  return {
    async execute(context, toolArgs, options?: ExecutorOptions) {
      return await shellThrough(executor, hostInput, context, toolArgs, options);
    },
  };
}

/** The browser driver's window index for a conversation: the box must be ready before its window is looked up. */
async function windowIndexOf<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context): Promise<number | undefined> {
  const boxId = hostInput.getBoxId();
  await hostInput.box.ensureReady(context, boxId);
  return hostInput.box.getAgentWindowIndex(boxId);
}

/** A shell result read as the browser driver's outcome: its success fields, or its failure case. */
function shellOutcome(result: HostShellResult): { case: "success"; stdout: string; stderr: string; exitCode: number } | { case: string } {
  if (result.result.case === "success") {
    return {
      case: "success",
      stdout: result.result.value?.stdout ?? "",
      stderr: result.result.value?.stderr ?? "",
      exitCode: result.result.value?.exitCode ?? 0,
    };
  }
  return { case: result.result.case ?? "" };
}

/** Send one file into the box for a conversation. */
async function uploadIntoBox<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context, boxId: string, path: string, bytes: Uint8Array): Promise<void> {
  await hostInput.box.uploadFile(context, boxId, path, bytes);
}

/** Take one file out of the box for a conversation. */
async function downloadFromBox<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context, boxId: string, path: string): Promise<Uint8Array> {
  return await hostInput.box.downloadFile(context, boxId, path);
}

/** Run one shell request through the shell projection the host supplied. */
async function shellViaDriver<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context, shellInput: HostShellArgsInput): Promise<{ case: "success"; stdout: string; stderr: string; exitCode: number } | { case: string }> {
  return shellOutcome(await hostInput.executeShell.execute(context, shellInput));
}

/**
 * Projects the immutable browser identity contract. Window readiness is checked before lookup; an unassigned window
 * remains undefined so the browser driver retains its shipped missing-view error. The transcript ID is the default
 * view identity, not a synthetic literal.
 */
export function createHostBrowserDriverDependencies<Context = unknown>(
  hostInput: HostBrowserDriverProjectionInput<Context>,
): BrowserDriverDependencies<Context> {
  return {
    resourceAccessor: hostInput.resourceAccessor,
    async getWindowIndex(context) {
      return await windowIndexOf(hostInput, context);
    },
    getBoxId: hostInput.getBoxId,
    getDefaultViewId: hostInput.getDefaultViewId,
    async uploadFile(context, boxId, path, bytes) {
      await uploadIntoBox(hostInput, context, boxId, path, bytes);
    },
    async downloadFile(context, boxId, path) {
      return await downloadFromBox(hostInput, context, boxId, path);
    },
    async executeShell(context, shellInput) {
      return shellViaDriver(hostInput, context, shellInput);
    },
    ...(hostInput.getPersistImage === undefined ? {} : { getPersistImage: hostInput.getPersistImage }),
    ...(hostInput.autoReview === undefined ? {} : { autoReview: hostInput.autoReview }),
  };
}
