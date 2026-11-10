/** Firing one automation: the rules it runs under, and what is recorded about it.

 * A wake is fired once at a time, behind the spend spend when the user is away, with the routine's own prompt and its
 * notices; whatever it comes to — delivered, interrupted by an update, failed — is written back onto the automation's
 * own run ledger and reported, with a failure only shown to the user once per kind of failure. */
import { dirname } from "node:path";
import {
  buildAutomationWakePrompt,
  buildGroupAutomationSeed,
  describeTriggerEventBatch,
  type AutomationRecord,
  type AutomationRunTrigger,
} from "../automations/automation.ts";
import { stableAutomationId } from "../automations/automation-id.ts";
import { routineNoticesToRaise } from "../automations/routine-notices.ts";
import { readSlateGroupConfig } from "../groups/group-store.ts";
import { isTransientStreamError } from "../runner/transient-stream-error.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import { errorMessage } from "../../shared/errors/summary.ts";
import { formatRemoteAgentId } from "../../shared/agents/sharing.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { GroupChatOrchestrator } from "./group-chat-orchestrator.ts";
import {
  isBackgroundAutomationTrigger,
  normalizeAutomationErrorKind,
  shouldNotifyAutomationFailure,
} from "./slate-automation-failure.ts";
import { createUserMessage } from "./send-message-shaping.ts";
import { allocateTranscriptEntryId } from "./transcript-entry-ids.ts";
import { getTranscript } from "./transcript-store.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export type FireAutomationOutcome = "ok" | "error" | "interrupted" | undefined;
export interface FireAutomationArgs {
  agentId: string;
  automation: AutomationRecord;
  trigger: AutomationRunTrigger;
  events?: Record<string, unknown>[];
  runUuid?: string;
  coalescedRunUuids?: string[];
  scheduledForMs?: number;
}

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function streamRetryPolicy(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    maxAttempts: intFromEnv("SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS", 4, 1),
    baseDelayMs: intFromEnv("SLATE_AUTOMATION_STREAM_RETRY_BASE_MS", 1_000, 0),
    maxDelayMs: intFromEnv("SLATE_AUTOMATION_STREAM_RETRY_MAX_MS", 15_000, 0),
    ...overrides,
  };
}

export class AutomationRunPath {
  readonly inFlightAutomationKeys = new Set<string>();
  readonly automationFailureOccurrences = new Map<string, number>();

  constructor(
    readonly tm: TranscriptManagerLike,
    readonly spendGuard: any,
    readonly eventFires: any,
  ) {}

  async runGroupAutomation(
    conversation: any,
    automation: AutomationRecord,
    events?: readonly Record<string, unknown>[],
  ): Promise<void> {
    const groupConfig = readSlateGroupConfig(dirname(conversation.dbPath));
    if (groupConfig == null) return;
    const isActive = this.tm.sessions.activeSession?.id === conversation.id;
    const transcriptEntries = isActive
      ? getTranscript()
      : conversation.db.getTranscriptEntries();
    const seed = createUserMessage(
      allocateTranscriptEntryId(transcriptEntries, "user-message"),
      buildGroupAutomationSeed(automation, events),
      {},
    );
    if (isActive) this.tm.appendEntry(seed);
    else {
      conversation.db.appendTranscriptEntry(seed);
      this.tm.sessionStore.markSessionActivity(conversation);
      void this.tm.roster.emitAgentUpdate(conversation.id);
    }
    this.tm.sharedRooms.publishSharedRoomEntryIfNeeded(conversation, seed);
    const orchestrator = new GroupChatOrchestrator(
      this.tm.groupChat.groupOrchestratorDeps(
        conversation,
        this.tm.sendPipeline.currentTurnEpoch(conversation),
        undefined,
        "background",
        "automation",
      ),
    );
    await orchestrator.run({
      group: this.tm.groupChat.groupIdentityFor(conversation),
      memberIds: [
        ...groupConfig.memberIds,
        ...(groupConfig.remoteMembers ?? []).map(formatRemoteAgentId),
      ],
    });
  }

  async fireAutomation(
    input: FireAutomationArgs,
  ): Promise<FireAutomationOutcome> {
    if (!this.tm.execution.canExecute) return undefined;
    const runLockKey = `${input.agentId}:${input.automation.id}`;
    const queuedEvents = input.events ?? [];
    const hasEventBatch = queuedEvents.length > 0;
    if (!hasEventBatch) {
      if (this.inFlightAutomationKeys.has(runLockKey)) {
        this.eventFires.reportFireDropped({
          agentId: input.agentId,
          trigger: input.trigger,
          reason: "duplicate_in_flight",
          ...(input.scheduledForMs === undefined
            ? {}
            : { scheduledForMs: input.scheduledForMs }),
          ...(input.runUuid === undefined ? {} : { runUuid: input.runUuid }),
        });
        return undefined;
      }
      this.inFlightAutomationKeys.add(runLockKey);
    }
    let finalOutcome: FireAutomationOutcome;
    try {
      let conversation: any;
      try {
        conversation = await this.tm.sessions.resolveBackgroundSession(input.agentId);
      } catch {
        return undefined;
      }
      const isGroup = this.tm.groupChat.isGroupSession(conversation);
      const executorRun = isGroup ? null : this.tm.runnerRegistry.getRunner(conversation);
      let spendGuardReminder: string | undefined;
      if (!isGroup && isBackgroundAutomationTrigger(input.trigger)) {
        const spend = await this.spendGuard.apply(conversation, input.automation);
        if (spend.paused) {
          this.eventFires.reportFireDropped({
            agentId: input.agentId,
            trigger: input.trigger,
            reason: "user_away_paused",
            ...(input.scheduledForMs === undefined
              ? {}
              : { scheduledForMs: input.scheduledForMs }),
            ...(input.runUuid === undefined ? {} : { runUuid: input.runUuid }),
          });
          return undefined;
        }
        spendGuardReminder = spend.reminder;
      }
      await this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
        agentId: conversation.id,
        mutation: () => {
          if (this.tm.sessions.activeSession?.id === conversation.id)
            this.tm.automationRuntime.recordAutomationChangeEvents(
              conversation,
              "agent",
            );
          else {
            const latest = conversation.automations.listDefinitions();
            this.tm.automationRuntime.recordInactiveAutomationChanges({
              agentId: conversation.id,
              before: latest,
              after: latest,
              source: "agent",
            });
          }
        },
      });
      this.recordAutomationRun(conversation, input.automation.id);
      const automationsBeforeRun = conversation.automations.listDefinitions();
      this.tm.runLifecycle.beginSessionRun(conversation);
      await this.tm.runLifecycle.enqueueExclusiveRun(
        conversation.id,
        async () => {
          finalOutcome = "error";
          this.tm.turnRuntime.activeRequestSources.set(
            conversation.id,
            "automation",
          );
          const runHandle = this.beginAutomationRun({
            conversation,
            automationId: input.automation.id,
            trigger: input.trigger,
            ...(hasEventBatch
              ? { eventSummary: describeTriggerEventBatch(queuedEvents) }
              : {}),
            ...(input.runUuid === undefined ? {} : { runUuid: input.runUuid }),
            ...(input.coalescedRunUuids?.length
              ? { coalescedRunUuids: input.coalescedRunUuids }
              : {}),
          });
          const startedMs = Date.now();
          let reportedOutcome: Exclude<FireAutomationOutcome, undefined> =
            "error";
          let sentMessageCount: number | undefined;
          try {
            if (isGroup) {
              await this.runGroupAutomation(
                conversation,
                input.automation,
                hasEventBatch ? queuedEvents : undefined,
              );
              this.finishAutomationRun(
                conversation,
                input.automation.id,
                runHandle,
                "ok",
              );
              reportedOutcome = "ok";
            } else if (executorRun != null) {
              const currentAutomation =
                conversation.automations.get(input.automation.id) ?? input.automation;
              for (const notice of routineNoticesToRaise(currentAutomation))
                conversation.automations.markNoticeRaised(
                  input.automation.id,
                  notice.id,
                );
              const wakeResult = await executorRun.run(
                `${buildAutomationWakePrompt(currentAutomation, { timeZone: this.tm.sessionStore.getUserTimeZone(), ...(hasEventBatch ? { events: queuedEvents } : {}), ...(input.trigger === "manual" ? { trigger: "manual" as const } : {}) })}${spendGuardReminder == null ? "" : `\n\n${spendGuardReminder}`}`,
                {
                  hidden: true,
                  isSilenceAllowed: true,
                  automationWake: {
                    id: input.automation.id,
                    name: input.automation.name,
                    ...(hasEventBatch
                      ? { containsUntrustedEventText: true }
                      : {}),
                  },
                  requestSource: "automation",
                  transientStreamRetry: streamRetryPolicy({
                    onRetry: (info: any) =>
                      console.info(
                        `[slate:automation] transient stream reset on "${input.automation.name}" (${input.automation.id}); retrying (attempt ${info.attempt}) after ${info.delayMs}ms: ${errorMessage(info.error)}`,
                      ),
                  }),
                },
              );
              sentMessageCount = wakeResult.sentMessageCount;
              if (wakeResult.quiescedForUpgrade) {
                this.finishAutomationRun(
                  conversation,
                  input.automation.id,
                  runHandle,
                  "error",
                  "Interrupted by a host update; resuming after restart.",
                );
                this.tm.upgradeResume.markAgentResumePending(
                  conversation,
                  "automation",
                  {
                    automationId: input.automation.id,
                    ...(runHandle == null ? {} : { automationRunId: runHandle }),
                  },
                );
                reportedOutcome = "interrupted";
              } else {
                this.finishAutomationRun(
                  conversation,
                  input.automation.id,
                  runHandle,
                  wakeResult.aborted ? "error" : "ok",
                  wakeResult.aborted
                    ? "Interrupted before it finished."
                    : undefined,
                );
                reportedOutcome = wakeResult.aborted ? "interrupted" : "ok";
              }
            }
            await this.tm.roster.emitAgentUpdate(conversation.id);
            this.tm.automationRuntime.emitAutomations(conversation);
          } catch (error) {
            this.tm.telemetry.reportAgentError({
              source: "automation",
              conversationId: conversation.id,
              requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
                conversation.id,
              ),
              error: classifyAgentError(error),
              detail: slateErrorDetail(error),
            });
            const failureFacts = describeAgentRunError(error) as Record<
              string,
              any
            >;
            const failureDetail =
              isTransientStreamError(error) &&
              failureFacts.errorKind == null &&
              failureFacts.rawDetail == null
                ? `Lost the connection repeatedly and gave up after retrying: ${failureFacts.detail}`
                : String(failureFacts.detail);
            this.finishAutomationRun(
              conversation,
              input.automation.id,
              runHandle,
              "error",
              failureDetail,
            );
            this.tm.automationRuntime.emitAutomations(conversation);
            this.notifyAutomationFailure(
              conversation,
              input.automation,
              failureDetail,
              input.trigger,
              failureFacts,
            );
            reportedOutcome = "error";
          } finally {
            if (reportedOutcome === "ok")
              this.clearAutomationFailureState(conversation.id, input.automation.id);
            this.tm.runLifecycle.endSessionRun(conversation);
            this.tm.telemetry.reportAutomationRun({
              conversationId: conversation.id,
              automationId: stableAutomationId({
                agentId: conversation.id,
                localId: input.automation.id,
              }),
              trigger: input.trigger,
              outcome: reportedOutcome,
              isGroup,
              durationMs: Date.now() - startedMs,
              ...(input.scheduledForMs === undefined
                ? {}
                : {
                    scheduledForMs: input.scheduledForMs,
                    latenessMs: Math.max(0, startedMs - input.scheduledForMs),
                  }),
              ...(sentMessageCount === undefined ? {} : { sentMessageCount }),
              ...(hasEventBatch ? { eventBatchSize: queuedEvents.length } : {}),
            });
            await this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
              agentId: conversation.id,
              mutation: () => {
                if (this.tm.sessions.activeSession?.id === conversation.id)
                  this.tm.automationRuntime.recordAutomationChangeEvents(
                    conversation,
                    "agent",
                  );
                else
                  this.tm.automationRuntime.recordInactiveAutomationChanges({
                    agentId: conversation.id,
                    before: automationsBeforeRun,
                    after: conversation.automations.listDefinitions(),
                    source: "agent",
                  });
              },
            });
            finalOutcome = reportedOutcome;
          }
        },
        { lane: "background", source: "automation" },
      );
    } finally {
      if (!hasEventBatch) this.inFlightAutomationKeys.delete(runLockKey);
    }
    return finalOutcome;
  }

  notifyAutomationFailure(
    conversation: any,
    automation: AutomationRecord,
    failureDetail: string,
    trigger: AutomationRunTrigger,
    failureFacts: Record<string, any>,
  ): void {
    if (isBackgroundAutomationTrigger(trigger)) return;
    const failureKind = normalizeAutomationErrorKind(failureDetail);
    const key = `${conversation.id}:${automation.id}:${failureKind}`;
    const seenCount = (this.automationFailureOccurrences.get(key) ?? 0) + 1;
    this.automationFailureOccurrences.set(key, seenCount);
    if (!shouldNotifyAutomationFailure(seenCount)) return;
    this.tm.trayErrors.pushError({
      agentId: conversation.id,
      title: `Automation "${automation.name}" failed`,
      detail: failureDetail,
      ...(failureFacts.errorKind == null
        ? {}
        : { errorKind: failureFacts.errorKind }),
      ...(failureFacts.rawDetail == null
        ? {}
        : { rawDetail: failureFacts.rawDetail }),
      ...(failureFacts.actions == null ? {} : { actions: failureFacts.actions }),
      dedupeKey: `automation-failure:${conversation.id}:${automation.id}:${failureKind}`,
      count: seenCount,
    });
  }
  clearAutomationFailureState(agentId: string, automationId: string): void {
    for (const key of this.automationFailureOccurrences.keys())
      if (key.startsWith(`${agentId}:${automationId}:`))
        this.automationFailureOccurrences.delete(key);
  }
  recordAutomationRun(conversation: any, automationId: string): void {
    try {
      conversation.automations.recordRunDefinition(automationId);
    } catch {}
  }
  beginAutomationRun(input: {
    conversation: any;
    automationId: string;
    trigger: AutomationRunTrigger;
    eventSummary?: string;
    runUuid?: string;
    coalescedRunUuids?: string[];
  }): string | null {
    try {
      return (
        input.conversation.automations.beginRun({
          id: input.automationId,
          trigger: input.trigger,
          ...(input.eventSummary === undefined
            ? {}
            : { event: input.eventSummary }),
          ...(input.runUuid === undefined ? {} : { runId: input.runUuid }),
          ...(input.coalescedRunUuids === undefined
            ? {}
            : { coalescedRunIds: input.coalescedRunUuids }),
        })?.id ?? null
      );
    } catch {
      return null;
    }
  }
  finishAutomationRun(
    conversation: any,
    automationId: string,
    runHandle: string | null,
    status: "ok" | "error",
    failureDetail?: string,
  ): void {
    if (runHandle == null) return;
    try {
      conversation.automations.finishRunDefinition({
        id: automationId,
        runId: runHandle,
        status,
        ...(failureDetail === undefined ? {} : { detail: failureDetail }),
      });
    } catch {}
  }
}
