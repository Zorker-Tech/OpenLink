/**
 * Starting a shell that outlives the command that asked for it.
 *
 * A background shell is started through the same executor a foreground command uses, with the workspace's ignoreSource
 * mapping and the command's own sandbox sandboxRule, and then left to run: what the platform keeps is the shell itself — its
 * process, its input, and the events it produces — so it can be written to, watched and stopped later. Starting it
 * waits only until the shell reports that it is ready to be written to, since waiting for a command that may run for
 * hours would defeat the point.
 */
import { resolve } from "node:path";
import type { Context } from "../context/context.ts";
import { BackgroundShellSpawnError, BackgroundShellSpawnResult, BackgroundShellSpawnSuccess } from "../proto/generated/agent/v1/background_shell_exec_pb.ts";
import { ShellPermissionDenied, ShellRejected, ShellSandboxUnsupported } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import { ShellCommandParsingResult } from "../proto/generated/agent/v1/shell_exec_pb.ts";
import type { SandboxPolicy as ProtoSandboxPolicy } from "../proto/generated/agent/v1/sandbox_pb.ts";
import { getShellHookApprovalRequirement } from "../agent-exec/shell-hook-approval.ts";
import { analyzeShellCommand } from "../shell-exec/shell-parser.ts";
import { SandboxUnsupportedError } from "../shell-exec/sandbox/errors.ts";
import { convertProtoToInternalPolicy } from "./sandbox-conversion.ts";
import { isForcedShellEgressEnabled, forcedShellSandboxPolicy } from "./forced-egress.ts";
import { getModelShellAdminCommandDenylistBlockReason } from "./services/admin-command-denylist.ts";
import { shellBlockReasonMessage } from "./utils/edit-block-handler.ts";
import type { ShellBlockReason } from "./utils/edit-block-handler.ts";
import type { Context as ShellCoreContext } from "../context/context.ts";
import type { SandboxPolicy, SandboxRule, ShellCoreArgs, ShellCoreEvent } from "./shell-core.ts";
import {
  BackgroundShellManager,
  ConversationOwnerOverrideRegistry,
  CoreBackgroundShell,
  type BackgroundAdoptState,
  type BackgroundShell,
  type BackgroundShellFactory,
  type BackgroundSpawnContext,
  type BackgroundWorkRegistry,
} from "./background-shell-lifecycle.ts";
import { FileLoggingShellFactory, NotifyingBackgroundShellFactory } from "./background-shell-observability.ts";

export { BackgroundShellManager } from "./background-shell-lifecycle.ts";
export type {
  BackgroundAdoptState,
  BackgroundShell,
  BackgroundShellFactory,
  BackgroundSpawnContext,
  BackgroundWorkRegistry,
} from "./background-shell-lifecycle.ts";
export type BackgroundCompletion = import("./background-shell-lifecycle.ts").ShellCompletion;

async function drainShellEvents(shell: CoreBackgroundShell, eventIterator: AsyncIterator<ShellCoreEvent>): Promise<void> {
  let finalCompletion: import("./background-shell-lifecycle.ts").ShellCompletion | undefined;
  try {
    for (let result = await eventIterator.next(); !result.done; result = await eventIterator.next()) {
      if (result.value.type === "stdin_ready") {
        shell.stdin = result.value.stdin;
        shell.pid = result.value.pid;
      } else if (result.value.type === "exit") {
        finalCompletion = {
          code: result.value.code,
          aborted: result.value.aborted,
          ...(result.value.outputLocation?.filePath === undefined ? {} : { outputPath: result.value.outputLocation.filePath }),
        };
      }
    }
  } catch {
    // Background finalCompletion is finalized below; the original execution error is
    // owned by the foreground stream and is intentionally not rethrown here.
  } finally {
    shell.markCompleted(finalCompletion ?? { code: null, aborted: shell.signal.aborted });
  }
}

interface BackgroundExecutorPort {
  execute(ctx: ShellCoreContext, args: ShellCoreArgs): AsyncIterable<ShellCoreEvent>;
}

interface LocalBackgroundExecutorPort extends BackgroundExecutorPort {
  getCwd(): Promise<string>;
}

function looksLikeBackgroundExecutor(value: unknown): value is BackgroundExecutorPort {
  return typeof value === "object" && value !== null && "execute" in value && typeof value.execute === "function";
}

function startInBackground(fn: () => Promise<void>): void {
  fn().catch(() => {});
}

export class CoreShellFactory implements BackgroundShellFactory {
  async spawn(context: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell> {
    if (!looksLikeBackgroundExecutor(coreExecutor)) throw new TypeError("Background shell core executor is not configured");
    const abortController = new AbortController();
    const shell = new CoreBackgroundShell(context.shellId, abortController);
    const eventIterator = coreExecutor.execute(context.ctx, {
      command: context.command,
      workingDirectory: context.workingDirectory,
      signal: abortController.signal,
      ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
      ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
      ...(context.sandboxPolicy === undefined ? {} : { sandboxPolicy: context.sandboxPolicy }),
      ...(context.enableWriteShellStdinTool === undefined ? {} : { pipeStdin: context.enableWriteShellStdinTool }),
      showElapsedTime: true,
    })[Symbol.asyncIterator]();
    try {
      for (let result = await eventIterator.next(); !result.done; result = await eventIterator.next()) {
        if (result.value.type === "stdin_ready") {
          shell.stdin = result.value.stdin;
          shell.pid = result.value.pid;
          break;
        }
      }
    } catch (error) {
      if (error instanceof SandboxUnsupportedError) throw error;
    }
    startInBackground(() => drainShellEvents(shell, eventIterator));
    return shell;
  }

  async adopt(state: BackgroundAdoptState): Promise<BackgroundShell> {
    const shell = new CoreBackgroundShell(state.shellId, state.abortController);
    shell.stdin = state.stdin;
    shell.pid = state.pid;
    startInBackground(() => drainShellEvents(shell, state.eventIterator));
    return shell;
  }
}

type PolicyDecision = { kind: "block"; reason: ShellBlockReason } | { kind: "allow"; policy?: SandboxRule };
export interface BackgroundPermissions {
  shouldEnforceShellInvariantBlocks(ctx: Context, options: unknown, sandboxRule: SandboxRule | undefined): Promise<PolicyDecision>;
  shouldBlockShellCommand(ctx: Context, command: string, options: unknown, sandboxRule: SandboxRule | undefined): Promise<PolicyDecision>;
}
function shellFactoryFor(workspaceDir: string): BackgroundShellFactory {
  const coreFactory = new CoreShellFactory();
  return new FileLoggingShellFactory(coreFactory, workspaceDir);
}

export class LocalBackgroundShellExecutor {
  private readonly shellManager: BackgroundShellManager;

  constructor(
    private readonly permissionChecks: BackgroundPermissions,
    private readonly coreExecutor: LocalBackgroundExecutorPort,
    private readonly ignoreSource: { getCursorIgnoreMapping(): Promise<unknown> },
    private readonly workspaceDir: string,
    factory?: BackgroundShellFactory,
    workRegistry?: BackgroundWorkRegistry,
    wakeupOwner?: string,
  ) {
    const ownedWorkRegistry = workRegistry !== undefined && wakeupOwner !== undefined
      ? new ConversationOwnerOverrideRegistry(workRegistry, wakeupOwner)
      : workRegistry;
    const baseFactory = factory ?? shellFactoryFor(workspaceDir);
    const notifyingFactory = new NotifyingBackgroundShellFactory(baseFactory, workspaceDir, ownedWorkRegistry);
    this.shellManager = new BackgroundShellManager(notifyingFactory, ownedWorkRegistry);
  }

  getManager(): BackgroundShellManager { return this.shellManager; }
  dispose(): void { this.shellManager.dispose(); }

  async execute(ctx: Context, args: {
    command: string;
    workingDirectory?: string;
    toolCallId?: string;
    conversationId?: string;
    sandboxPolicy?: ProtoSandboxPolicy;
    adminCommandDenylist?: readonly string[];
    skipApproval?: boolean;
    smartModeApproval?: { reason?: string; requestId?: string };
    classifierResult?: unknown;
    enableWriteShellStdinTool?: boolean;
    description?: string;
    outputNotification?: unknown;
    hookApprovalRequirement?: import("../proto/generated/agent/v1/shell_exec_pb.ts").ShellHookApprovalRequirement;
  }): Promise<BackgroundShellSpawnResult> {
    const command = args.command;
    const workingDirectory = resolve(args.workingDirectory || await this.coreExecutor.getCwd());
    const parsedCommand = analyzeShellCommand(command).structured;
    const parsingResult = new ShellCommandParsingResult({
      parsingFailed: parsedCommand.parsingFailed,
      executableCommands: parsedCommand.executableCommands.map((item) => ({
        name: item.name,
        fullText: item.fullText,
        args: item.args.map((arg) => ({ type: arg.type, value: arg.value })),
      })),
      hasRedirects: parsedCommand.hasRedirects,
      hasCommandSubstitution: parsedCommand.hasCommandSubstitution,
      ...(parsedCommand.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: parsedCommand.allRedirectsAreDevNull }),
      redirects: parsedCommand.redirects.map((item) => ({
        operator: item.operator,
        destinationFds: [...item.destinationFds],
        targetNodeType: item.targetNodeType,
        ...(item.targetText === undefined ? {} : { targetText: item.targetText }),
      })),
    });
    const denylistReason = getModelShellAdminCommandDenylistBlockReason({ command, parsingResult: parsingResult, blockedCommands: args.adminCommandDenylist ?? [] });
    if (denylistReason !== undefined) return new BackgroundShellSpawnResult({ result: { case: "rejected", value: new ShellRejected({ command, workingDirectory, reason: denylistReason }) } });
    let sandboxRule = args.sandboxPolicy ? convertProtoToInternalPolicy(args.sandboxPolicy) : undefined;
    const preflightDecision = args.skipApproval
      ? await this.permissionChecks.shouldEnforceShellInvariantBlocks(ctx, { workingDirectory, skipUnsafeWorkingDirectoryBlock: true, command, parsingResult: parsingResult, toolCallId: args.toolCallId }, sandboxRule)
      : await this.permissionChecks.shouldBlockShellCommand(ctx, command, { workingDirectory, timeout: 0, parsingResult: parsingResult, toolCallId: args.toolCallId, classifierResult: args.classifierResult, smartModeApprovalReason: args.smartModeApproval?.reason, smartModeApprovalRequestId: args.smartModeApproval?.requestId, hookApprovalRequirement: getShellHookApprovalRequirement(args) }, sandboxRule);
    if (preflightDecision.kind === "block") {
      if (preflightDecision.reason.type === "permissionsConfig") return new BackgroundShellSpawnResult({ result: { case: "permissionDenied", value: new ShellPermissionDenied({ command, workingDirectory, error: "Command blocked by permissions configuration", isReadonly: preflightDecision.reason.isReadonly ?? false }) } });
      return new BackgroundShellSpawnResult({ result: { case: "rejected", value: new ShellRejected({ command, workingDirectory, reason: shellBlockReasonMessage(preflightDecision.reason) }) } });
    }
    sandboxRule = preflightDecision.policy;
    if (isForcedShellEgressEnabled()) {
      sandboxRule = forcedShellSandboxPolicy(command, parsingResult);
      if (sandboxRule.type !== "insecure_none") sandboxRule = { ...sandboxRule, ignoreMapping: await this.ignoreSource.getCursorIgnoreMapping() };
    }
    try {
      const shellId = this.shellManager.generateShellId();
      const spawn = await this.shellManager.spawn({
        ctx,
        shellId,
        command,
        workingDirectory,
        ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
        ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
        ...(sandboxRule === undefined ? {} : { sandboxPolicy: { perRepo: sandboxRule } }),
        ...(args.enableWriteShellStdinTool === undefined ? {} : { enableWriteShellStdinTool: args.enableWriteShellStdinTool }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.outputNotification === undefined ? {} : { outputNotification: args.outputNotification }),
      }, this.coreExecutor);
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({ shellId, command, workingDirectory, ...(spawn.pid === undefined ? {} : { pid: spawn.pid }) }) } });
    } catch (error) {
      if (error instanceof SandboxUnsupportedError) {
        const type = sandboxRule?.type ?? "unknown";
        return new BackgroundShellSpawnResult({ result: { case: "sandboxUnsupported", value: new ShellSandboxUnsupported({ command, workingDirectory, sandboxPolicyType: type, reason: error.reason ?? error.message, isReadonly: type === "workspace_readonly" }) } });
      }
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command, workingDirectory, error: error instanceof Error ? error.message : "Unknown error" }) } });
    }
  }

  writeStdin(id: number, data: string): Promise<void> { return this.shellManager.writeStdin(id, data); }
}
