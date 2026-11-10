/** Turns one local shell run into a cancellable stream that can be handed to the background manager. */
import { resolve } from "node:path";
import type { Context } from "../context/context.ts";
import { SandboxUnsupportedError } from "../shell-exec/sandbox/errors.ts";
import type { BackgroundShellManager } from "./background-shell.ts";
import type { BaseShellCoreExecutor, SandboxPolicy } from "./shell-core.ts";
import { ShellStreamForegroundRuns } from "./shell-stream-foreground-runs.ts";
import { ShellStreamHandoff } from "./shell-stream-handoff.ts";
import {
  backgroundedShellEvent,
  permissionDeniedShellEvent,
  rejectedShellEvent,
  shellExitEvent,
  shellOutputEvent,
  startedShellEvent,
  unsupportedSandboxShellEvent,
  userAbortedShellEvent,
} from "./shell-stream-events.ts";
import { parseShellCommand } from "./shell-stream-analysis.ts";
import { requestedShellPolicy, forcedShellPolicy } from "./shell-stream-policy.ts";
import { resolveShellTimeoutMs } from "./shell-timeout.ts";
import { getModelShellAdminCommandDenylistBlockReason } from "./services/admin-command-denylist.ts";
import { shellBlockReasonMessage } from "./utils/edit-block-handler.ts";
import type { ShellCommandPermissions, ShellForegroundResult, ShellStreamArgs, WorkspaceIgnoreSource } from "./shell-stream-contracts.ts";
import type { LocalShellStreamEvent } from "./shell-stream-events.ts";

export type { ShellIgnoreService, ShellPermissions, ShellStreamArgs } from "./shell-stream-contracts.ts";

export class LocalShellStreamExecutor {
  private readonly activeRuns = new ShellStreamForegroundRuns();

  constructor(
    private readonly permissions: ShellCommandPermissions,
    private readonly core: BaseShellCoreExecutor,
    private readonly ignore: WorkspaceIgnoreSource,
    private readonly background: BackgroundShellManager,
  ) {}

  async forceBackgroundByToolCallId(toolCallId: string): Promise<LocalShellForegroundHandoff> {
    const result = this.activeRuns.requestBackground(toolCallId);
    if (result === undefined) return { status: "not_found" };
    return { status: "accepted", shellResult: result };
  }

  async *execute(ctx: Context, args: ShellStreamArgs): AsyncIterable<LocalShellStreamEvent> {
    ctx.signal.throwIfAborted();

    const command = args.command;
    let policy = await requestedShellPolicy(args.requestedSandboxPolicy, this.ignore);
    const shellDirectory = args.workingDirectory || await this.core.getCwd();
    const resolvedDirectory = resolve(shellDirectory);
    const startedAt = Date.now();
    const timeout = resolveShellTimeoutMs({
      timeout: args.timeout ?? 0,
      isBackground: args.isBackground ?? false,
      ...(args.timeoutBehavior === undefined ? {} : { timeoutBehavior: args.timeoutBehavior }),
      ...(args.hardTimeout === undefined ? {} : { hardTimeout: args.hardTimeout }),
    });
    const parsed = parseShellCommand(command);
    const deniedByList = getModelShellAdminCommandDenylistBlockReason({
      command,
      parsingResult: parsed,
      blockedCommands: args.adminCommandDenylist ?? [],
    });
    if (deniedByList !== undefined) {
      yield rejectedShellEvent(command, resolvedDirectory, deniedByList);
      return;
    }

    const invariant = await this.permissions.shouldEnforceShellInvariantBlocks(
      ctx,
      {
        workingDirectory: resolvedDirectory,
        skipUnsafeWorkingDirectoryBlock: true,
        command,
        parsingResult: parsed,
        toolCallId: args.toolCallId,
      },
      policy,
    );
    if (invariant.kind === "block") {
      if (invariant.reason.type === "permissionConfiguration") {
        yield permissionDeniedShellEvent(command, resolvedDirectory, invariant.reason.isReadOnly ?? false);
      } else {
        yield rejectedShellEvent(command, resolvedDirectory, shellBlockReasonMessage(invariant.reason));
      }
      return;
    }

    if (!args.skipApproval) {
      const approval = await this.permissions.shouldBlockShellCommand(
        ctx,
        command,
        {
          workingDirectory: resolvedDirectory,
          timeout,
          parsingResult: parsed,
          toolCallId: args.toolCallId,
          classifierResult: args.classifierResult,
          smartModeApprovalReason: args.smartModeApproval?.reason,
          smartModeApprovalRequestId: args.smartModeApproval?.requestId,
          hookApprovalRequirement: args.hookApprovalRequirement,
        },
        policy,
      );
      if (approval.kind === "block") {
        if (approval.reason.type === "permissionConfiguration") {
          yield permissionDeniedShellEvent(command, resolvedDirectory, approval.reason.isReadOnly ?? false);
        } else {
          yield rejectedShellEvent(command, resolvedDirectory, shellBlockReasonMessage(approval.reason));
        }
        return;
      }
      policy = approval.policy;
    }

    const egressPolicy = await forcedShellPolicy(command, parsed, this.ignore);
    if (egressPolicy !== undefined) policy = egressPolicy;
    yield startedShellEvent(policy);

    const backgroundOnTimeout = args.timeoutBehavior === "background";
    const pipeStdin = backgroundOnTimeout && !args.closeStdin && args.smartModeApproval === undefined;
    const stopController = new AbortController();
    const stopSignal = backgroundOnTimeout ? stopController.signal : AbortSignal.any([ctx.signal, stopController.signal]);
    const sandboxPolicy: SandboxPolicy | undefined = policy === undefined ? undefined : { perRepo: policy };
    const coreEvents = this.core.execute(ctx, {
      command,
      workingDirectory: shellDirectory,
      signal: stopSignal,
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(args.fileOutputThresholdBytes === undefined ? {} : { fileOutputThresholdBytes: args.fileOutputThresholdBytes }),
      pipeStdin,
      showElapsedTime: true,
    });
    const handoff = backgroundOnTimeout
      ? new ShellStreamHandoff(coreEvents[Symbol.asyncIterator](), timeout)
      : undefined;

    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    if (!backgroundOnTimeout) cancelTimer = setTimeout(() => stopController.abort(), timeout);

    let shellId: number | undefined;
    let processId: number | undefined;
    let inputStream: NodeJS.WritableStream | undefined;
    let capturedOutput = "";
    let processWasKilled = false;
    let unregisterForeground: (() => void) | undefined;

    if (args.toolCallId !== undefined && handoff !== undefined) {
      unregisterForeground = this.activeRuns.register(args.toolCallId, {
        requestBackground: () => {
          if (!handoff.requestBackground()) return undefined;
          shellId ??= this.background.generateShellId();
          return {
            shellId,
            ...(processId === undefined ? {} : { pid: processId }),
            command,
            workingDirectory: resolvedDirectory,
            msToWait: Date.now() - startedAt,
            backgroundReason: "user",
            interleavedOutput: capturedOutput,
          };
        },
      });
    }

    if (handoff !== undefined) {
      ctx.signal.addEventListener("abort", () => {
        if (!handoff.handedOff) {
          stopController.abort();
          handoff.abort();
        }
      }, { once: true });
    }

    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    if (args.hardTimeout !== undefined && args.hardTimeout > 0) {
      hardTimer = setTimeout(() => {
        if (shellId !== undefined) {
          if (!this.background.abort(shellId)) stopController.abort();
        } else {
          processWasKilled = true;
          stopController.abort();
          handoff?.abort();
        }
      }, args.hardTimeout);
    }

    try {
      const outputEvents = handoff === undefined ? coreEvents : handoff.read();
      for await (const event of outputEvents) {
        if (event.type === "stdout" || event.type === "stderr") {
          capturedOutput += event.data;
          yield shellOutputEvent(event.type, event.data);
        } else if (event.type === "stdin_ready") {
          inputStream = event.stdin;
          processId = event.pid;
        } else if (event.type === "exit") {
          yield shellExitEvent(
            event,
            await this.core.getCwd(),
            event.aborted ? (ctx.signal.aborted ? "user_abort" : "timeout") : undefined,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof SandboxUnsupportedError)) throw error;
      const policyType = (policy as { type?: string } | undefined)?.type ?? "unknown";
      yield unsupportedSandboxShellEvent({
        command,
        workingDirectory: resolvedDirectory,
        policyType,
        reason: error.reason ?? error.message,
        readonly: policyType === "workspace_readonly",
      });
      return;
    } finally {
      clearTimeout(cancelTimer);
      if (!handoff?.handedOff) clearTimeout(hardTimer);
      unregisterForeground?.();
    }

    if (handoff?.handedOff && !processWasKilled) {
      shellId ??= this.background.generateShellId();
      const reason = handoff.backgroundReason === "user" ? "user" : "timeout";
      const elapsedMs = reason === "user" ? Date.now() - startedAt : timeout;
      await this.background.adopt({
        ctx,
        shellId,
        command,
        workingDirectory: resolvedDirectory,
        ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
        ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
        initialOutput: capturedOutput,
        ...(inputStream === undefined ? {} : { stdin: inputStream }),
        ...(processId === undefined ? {} : { pid: processId }),
        abortController: stopController,
        eventIterator: handoff.continueInBackground(),
        startTime: startedAt,
        showElapsedTime: true,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.outputNotification === undefined ? {} : { outputNotification: args.outputNotification }),
      });
      yield backgroundedShellEvent({
        shellId,
        command,
        workingDirectory: resolvedDirectory,
        ...(processId === undefined ? {} : { pid: processId }),
        elapsedMs,
        reason,
      });
    } else if (ctx.signal.aborted && handoff?.stopReason !== undefined) {
      yield userAbortedShellEvent(await this.core.getCwd());
    } else {
      clearTimeout(hardTimer);
    }
  }
}

export type LocalShellForegroundHandoff =
  | { readonly status: "not_found" }
  | { readonly status: "accepted"; readonly shellResult: ShellForegroundResult }
