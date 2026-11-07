/**
 * Driving a box's desktop.
 *
 * A click, a keystroke or a screenshot is carried to the box over its own readyConnection, and what comes back is what the
 * desktop answered — with a monitor claimed for the agent so two agents do not drive the same screen.
 */
import {
  computerUseAuditKind,
  createSlateNavigationProbe,
} from "./slate-action-audit.ts";
import { computerUseExecutorResource } from "../../adapters/interop/agent/computer-use-executor-adapter.ts";
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts";
import { buildHostShellArgs } from "../../adapters/interop/agent/box-shell-command-adapter.ts";
import type { SlateComputerUseExecutorRequest, SlateComputerUseExecutorResult } from "../../packages/agent/conversation-step-state.ts";
import { isNoMonitorComputerUseExecutor } from "../ports/box.ts";
import { mergeTurnUsage, type TurnUsage } from "./turn-usage.ts";

export interface ComputerUseRemoteConnection<Context> {
  readonly remoteAccessor: unknown;
}

export interface ComputerUseActionAuditor {
  record(record: unknown): void;
}

export interface ComputerUseCoordinationDependencies<Context> {
  readonly ctx: Context;
  readonly remoteBox: {
    ensureReady(context: Context, boxId: string): Promise<ComputerUseRemoteConnection<Context>>;
  };
  readonly initialNavigationProbe?: ReturnType<typeof createSlateNavigationProbe<Context>>;
  getConversationId(): string;
  resolveBoxId(): string;
  actionAuditor(): ComputerUseActionAuditor | undefined;
  reportDiagnostic?(diagnostic: {
    readonly kind: "computer_use_prewarm_skipped";
    readonly stage: "box" | "browser";
    readonly errorClass: string;
  }): void;
  classifyError?(error: unknown): string;
}

interface ComputerUseResourceAccessor<Context> {
  get(resource: typeof computerUseExecutorResource): {
    execute(context: Context, args: SlateComputerUseExecutorRequest): Promise<SlateComputerUseExecutorResult>;
  };
  get(resource: typeof shellExecutorResource): {
    execute(context: Context, args: unknown): Promise<unknown>;
  };
}

function looksLikeComputerUseAccessor<Context>(value: unknown): value is ComputerUseResourceAccessor<Context> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function";
}

export interface ComputerUseUsageSnapshot {
  readonly modelId?: string | undefined;
  readonly turnEndedCount: number;
  readonly usage?: TurnUsage | undefined;
}

function failureKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createComputerUseCoordination<Context>(
  dependencies: ComputerUseCoordinationDependencies<Context>,
) {
  const windowByAgent = new Map<string, number>();
  const preparationByAgent = new Map<
    string,
    Promise<ComputerUseRemoteConnection<Context> | undefined>
  >();
  const auditCountsByKind = new Map<string, number>();
  const seenModelIds = new Set<string>();
  let endedTurnCount = 0;
  let accumulatedUsage: TurnUsage | undefined;
  let navigationProbeState = dependencies.initialNavigationProbe;

  function reportPreparationFailure(
    stage: "box" | "browser",
    error: unknown,
  ): void {
    dependencies.reportDiagnostic?.({
      kind: "computer_use_prewarm_skipped",
      stage,
      errorClass: dependencies.classifyError?.(error) ?? failureKind(error),
    });
  }

  return {
    allocateWindow(subagentAgentId: string): number | null {
      const claimedWindow = windowByAgent.get(subagentAgentId);
      if (claimedWindow != null) return claimedWindow;
      const mainWindowTaken = [...windowByAgent.values()].includes(1);
      if (mainWindowTaken) return null;
      windowByAgent.set(subagentAgentId, 1);
      return 1;
    },

    freeWindow(subagentAgentId: string): void {
      windowByAgent.delete(subagentAgentId);
      preparationByAgent.delete(subagentAgentId);
    },

    prepareRemoteBox({
      agentId,
      boxId,
    }: {
      readonly agentId: string;
      readonly boxId: string;
    }): Promise<ComputerUseRemoteConnection<Context> | undefined> {
      const readyConnection = dependencies.remoteBox.ensureReady(dependencies.ctx, boxId)
        .catch((error: unknown) => {
          reportPreparationFailure("box", error);
          return undefined;
        });
      const browserPreparation = readyConnection.then(async (preparedConnection) => {
        if (preparedConnection == null) return undefined;
        if (!looksLikeComputerUseAccessor<Context>(preparedConnection.remoteAccessor)) {
          throw new TypeError("computer-use remote accessor does not expose the required resources");
        }
        const computerExecutor = preparedConnection.remoteAccessor.get(computerUseExecutorResource);
        if (isNoMonitorComputerUseExecutor(computerExecutor)) return preparedConnection;
        await preparedConnection.remoteAccessor.get(shellExecutorResource).execute(
          dependencies.ctx,
          buildHostShellArgs({
            command: "box-chrome --slate-prepare",
            name: "box-chrome",
            workingDirectory: "/workspace",
            toolCallId: `slate-cua-browser-prepare-${agentId}`,
          }),
        );
        return preparedConnection;
      }).catch((error: unknown) => {
        reportPreparationFailure("browser", error);
        return undefined;
      });
      preparationByAgent.set(agentId, browserPreparation);
      return readyConnection;
    },

    preparationFor(subagentAgentId: string) {
      return preparationByAgent.get(subagentAgentId);
    },

    recordAuditIntent(actionName: string): void {
      if (dependencies.actionAuditor() == null) return;
      const auditKind = computerUseAuditKind(actionName);
      if (auditKind == null) return;
      auditCountsByKind.set(auditKind, (auditCountsByKind.get(auditKind) ?? 0) + 1);
    },

    auditActionCounts(): ReadonlyMap<string, number> {
      return auditCountsByKind;
    },

    recordTurnEnded(turnTokens: TurnUsage | undefined): void {
      endedTurnCount += 1;
      accumulatedUsage = mergeTurnUsage(accumulatedUsage, turnTokens);
    },

    recordModelId(modelId: string): void {
      seenModelIds.add(modelId);
    },

    usageSnapshot(): ComputerUseUsageSnapshot {
      const ids = [...seenModelIds];
      return {
        modelId: ids.length === 0 ? undefined : ids.length === 1 ? ids[0] : "mixed",
        turnEndedCount: endedTurnCount,
        usage: accumulatedUsage,
      };
    },

    getOrCreateNavigationProbe(): ReturnType<typeof createSlateNavigationProbe<Context>> | undefined {
      const auditorSink = dependencies.actionAuditor();
      if (auditorSink == null) return undefined;
      navigationProbeState ??= createSlateNavigationProbe({
        auditor: auditorSink,
        agentId: dependencies.getConversationId(),
        getBoxId: () => dependencies.resolveBoxId(),
      });
      return navigationProbeState;
    },
  };
}
