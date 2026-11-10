/** The runners a conversation runs on.

 * A activeRunner is created once per conversation and then wired: what it says about itself goes to the roster, what it
 * spends goes to telemetry, what it wakes and what it waits on go to the machinery that owns those, and what it fails
 * with is classified before it is reported. */
import { findBackendConnectError } from "./agent-run-error.ts";
import { createSlateTransport } from "../ports/transport.ts";
import { slateErrorWireCode } from "../../shared/errors/registry.ts";
import { classifyAgentError, connectCodeOf } from "./turn-runtime.ts";
import {
  RUNNER_UNATTACHED_MESSAGE,
  type TranscriptManagerLike,
} from "./transcript-hub.ts";

export class SlateRemoteRoomError extends Error {}

export function coarseErrorTypeAndCode(failure: unknown): {
  errorType: string;
  errorCode?: string;
} {
  const connectFailure = findBackendConnectError(failure, false);
  if (connectFailure != null) {
    const wireErrorCode = connectCodeOf(failure);
    return {
      errorType: "connect_error",
      ...(wireErrorCode == null ? {} : { errorCode: wireErrorCode }),
    };
  }
  if (failure instanceof Error)
    return { errorType: failure.name.length > 0 ? failure.name : "error" };
  return { errorType: "unknown" };
}

export class RunnerRegistry {
  readonly runners = new Map<string, any>();
  readonly activeGroupMemberRunners = new Map<string, any>();

  constructor(readonly tm: TranscriptManagerLike) {}

  interruptWedgedRunForWatchdog(agentId: string): boolean {
    const interruptReason = "run-queue watchdog: releasing a wedged predecessor";
    const wasRunning = this.tm.runLifecycle.runningAgentIds().has(agentId);
    const hadGroupMemberRun =
      this.activeGroupMemberRunners.get(agentId)?.interrupt(interruptReason) ?? false;
    const hadLiveRun =
      (this.runners.get(agentId)?.interrupt(interruptReason) ?? false) ||
      hadGroupMemberRun;
    this.tm.telemetry.reportTurnInterrupt({
      conversationId: agentId,
      reason: "watchdog",
      hadActiveRun: hadLiveRun,
      wasInFlight: wasRunning,
    });
    return hadLiveRun;
  }

  attachRunner(activeRunner: any): void {
    this.tm.attachRunnerFactory((sessionState: any, hookState: any) => {
      activeRunner.bindSessionServices({
        agentState: { store: sessionState.agentStore, profileProvider: hookState.agentProfileProvider },
        memory: {
          primary: sessionState.memory,
          snapshots: sessionState.db,
          profileSnapshots: sessionState.db,
          episodeProgress: sessionState.db,
        },
        automation: { automations: sessionState.automations, workflows: sessionState.workflows, channels: sessionState.channels },
        attachments: {
          ingestor: hookState.ingestAttachment,
          imagePersister: hookState.persistImage,
          mediaPersister: hookState.persistMediaBytes,
        },
      });
      activeRunner.setAgentIdProvider(() => sessionState.id);
      return activeRunner;
    });
  }

  attachRunnerFactory(runnerFactory: (...args: any[]) => any): void {
    this.tm.setTurnExecution({
      ...this.tm.execution,
      canExecute: true,
      createRunner: (sessionState: any, hookState: any) => runnerFactory(sessionState, hookState),
    });
  }
  attachGroupMemberRunnerFactory(runnerFactory: (...args: any[]) => any): void {
    this.tm.setTurnExecution({
      ...this.tm.execution,
      canExecuteGroupMember: true,
      createGroupMemberRunner: (sessionState: any, hookState: any, runnerOverrides: any) =>
        runnerFactory(sessionState, hookState, runnerOverrides),
    });
  }
  attachRunReadinessProbe(readinessProbe: () => Promise<boolean>): void {
    this.tm.setTurnExecution({ ...this.tm.execution, isRunReady: readinessProbe });
  }
  async isRunReady(): Promise<boolean> {
    return this.tm.execution.isRunReady();
  }

  getRunner(sessionState: any): any {
    if (this.tm.groupChat.isRemoteRoomSession(sessionState))
      throw new SlateRemoteRoomError(
        "This is a shared chat hosted by another user; it has no local agent to run.",
      );
    const existingRunner = this.runners.get(sessionState.id);
    if (existingRunner != null) {
      if (this.tm.upgradeResume.quiescingForUpgrade)
        existingRunner.requestQuiesceForUpgrade();
      return existingRunner;
    }
    if (!this.tm.execution.canExecute)
      throw new Error(RUNNER_UNATTACHED_MESSAGE);
    const activeRunner = this.tm.execution.createRunner(
      sessionState,
      this.runnerHooksFor(sessionState),
    );
    this.wireRunnerLifecycle(activeRunner, sessionState, sessionState.id);
    this.runners.set(sessionState.id, activeRunner);
    return activeRunner;
  }

  createGroupMemberRunner(
    sessionState: any,
    givenTransport: unknown,
    runnerOverrides: unknown,
  ): any {
    if (!this.tm.execution.canExecuteGroupMember)
      throw new Error(RUNNER_UNATTACHED_MESSAGE);
    const activeRunner = this.tm.execution.createGroupMemberRunner(
      sessionState,
      this.runnerHooksFor(sessionState, givenTransport),
      runnerOverrides,
    );
    this.wireRunnerLifecycle(activeRunner, sessionState, sessionState.id);
    return activeRunner;
  }

  wireRunnerLifecycle(
    activeRunner: any,
    sessionState: any,
    ttftId: string,
  ): any {
    if (this.tm.upgradeResume.quiescingForUpgrade)
      activeRunner.requestQuiesceForUpgrade();
    activeRunner.setBackgroundSubagentHandler((completionEvent: unknown) =>
      this.tm.backgroundWakes.handleBackgroundSubagentCompletion(completionEvent),
    );
    activeRunner.setBackgroundSubagentDispatchHandler((dispatchEvent: any) =>
      this.tm.productAnalytics.trackEvent("slate.subagent.dispatched", {
        parent_agent_id: dispatchEvent.parentAgentId,
        subagent_agent_id: dispatchEvent.subagentAgentId,
        subagent_type: dispatchEvent.subagentType,
        tool_call_id: dispatchEvent.toolCallId,
        subagent_request_id: dispatchEvent.subagentRequestId,
      }),
    );
    activeRunner.setComputerUseUsageHandler((reportData: any) => {
      const usageData = reportData.usage;
      this.tm.productAnalytics.trackEvent("slate.computer_use.usage", {
        parent_agent_id: reportData.parentAgentId,
        subagent_agent_id: reportData.subagentAgentId,
        subagent_type: reportData.subagentType,
        subagent_request_id: reportData.subagentRequestId,
        outcome: reportData.outcome,
        duration_ms: reportData.durationMs,
        tool_call_count: reportData.toolCallCount,
        turn_ended_count: reportData.turnEndedCount,
        has_usage: usageData != null,
        ...(reportData.modelId == null ? {} : { model_id: reportData.modelId }),
        ...(usageData == null
          ? {}
          : {
              input_tokens: usageData.inputTokens,
              output_tokens: usageData.outputTokens,
              cache_read_tokens: usageData.cacheReadTokens,
              cache_write_tokens: usageData.cacheWriteTokens,
              ...(usageData.reasoningTokens == null
                ? {}
                : { reasoning_tokens: usageData.reasoningTokens }),
            }),
      });
      this.tm.telemetry.reportComputerUseUsage(reportData);
    });
    activeRunner.setSubagentEventHandler((payloadEvent: unknown) =>
      this.tm.roster.emitSubagents(activeRunner, payloadEvent),
    );
    activeRunner.setAsyncTasksEventHandler((payloadEvent: unknown) =>
      this.tm.roster.emitAsyncTasks(activeRunner, payloadEvent),
    );
    activeRunner.setBackgroundShellHandler((completionEvent: unknown) =>
      this.tm.backgroundWakes.handleBackgroundShellCompletion(completionEvent),
    );
    activeRunner.setPendingWakeArmedHandler((payloadEvent: unknown) =>
      this.tm.pendingWakes.persistPendingWake(payloadEvent),
    );
    activeRunner.setPendingWakeDisarmedHandler((payloadEvent: unknown) =>
      this.tm.pendingWakes.disarmPendingWake(payloadEvent),
    );
    activeRunner.setTurnAwaitHandler((observationData: unknown) =>
      this.tm.telemetry.reportTurnAwait({
        conversationId: sessionState.id,
        ...(observationData as object),
      }),
    );
    activeRunner.setFirstTokenHandler((observationData: unknown) =>
      this.tm.telemetry.reportTtft({
        conversationId: ttftId,
        ...(observationData as object),
      }),
    );
    activeRunner.setSendDispatchHandler((observationData: unknown) =>
      this.tm.telemetry.reportSendDispatch({
        conversationId: sessionState.id,
        ...(observationData as object),
      }),
    );
    activeRunner.setTurnRetryHandler(({ error: failure, ...remaining }: any) => {
      const { errorType, errorCode: wireErrorCode } = coarseErrorTypeAndCode(failure);
      this.tm.telemetry.reportTurnRetry({
        conversationId: sessionState.id,
        ...remaining,
        errorType,
        ...(wireErrorCode == null ? {} : { errorCode: wireErrorCode }),
        cause: slateErrorWireCode(classifyAgentError(failure)),
      });
    });
    activeRunner.setToolCallDiagnosticHandler((observationData: unknown) =>
      this.tm.turnRuntime.reportToolCallDiagnostic(sessionState, observationData),
    );
    return activeRunner;
  }

  runnerHooksFor(sessionState: any, givenTransport?: unknown): Record<string, unknown> {
    return {
      transport:
        givenTransport ??
        createSlateTransport((update) =>
          this.tm.handleAgentUpdate(update, sessionState),
        ),
      onRunLifecycle: (payloadEvent: unknown) => this.tm.emitAgentRunLifecycle(payloadEvent),
      ingestAttachment: this.tm.createAttachmentIngestor(sessionState),
      persistImage: this.tm.createAssetImagePersister(sessionState),
      persistMediaBytes: this.tm.createMediaBytesPersister(sessionState),
      agentProfileProvider: () => this.tm.roster.resolveAgentProfile(sessionState),
    };
  }
}
