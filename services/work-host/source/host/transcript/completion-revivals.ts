/** Waking a conversation because something it started in the background finished.

 * A finished subagent or background command is queued against the conversation that started it, written into a prompt
 * that says what finished and whether the user is waiting on it, and run as a hidden turn — with every outcome reported
 * so a follow-up that never happened is visible. */
import { slateErrorDetail } from "../ports/telemetry.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import type { QuietWakeOrigin } from "./slate-pending-wake-store.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";
/** What a quiet run was started by, as the note names it. */
function quietOriginSource(origin: QuietWakeOrigin): string {
  if (origin.automation != null) return `your routine "${origin.automation.name}" (folder ${origin.automation.id})`;
  return "one of your own quiet self-initiated runs";
}

export function describeQuietOriginNote(origin: QuietWakeOrigin): string {
  const source = quietOriginSource(origin);
  return `(You started this during ${source} — nobody is waiting on it.)`;
}
/** Whether every completion in a batch came from a quiet run the user is not waiting on. */
export function isAllQuietOrigin(origins: readonly { quietOrigin?: QuietWakeOrigin }[]): boolean {
  return origins.every(origin => origin.quietOrigin != null);
}

/** One finished background task, as the revival prompt and the queue see it. */
export interface SubagentCompletion {
  subagentAgentId: string;
  parentAgentId: string;
  subagentType: string;
  title: string;
  status: string;
  result: string;
  quietOrigin?: QuietWakeOrigin;
}

/** The prompt a legacy quiet run resumes with, word for word. */
export const QUIET_REVIVAL_INSTRUCTION = `Pick the work back up. Everything above came out of your own quiet standing order(s) — the user did not ask to hear about it, so the saved instruction's delivery rule governs. If the outcome is a genuine change, a new actionable result, or a real blocker the user must know about, tell them once with a single useful SendMessage. If it amounts to no change, nothing new, or still waiting, end the turn with no SendMessage at all — no "still waiting" or progress notes; if the standing order says to keep watching, just keep the watch going quietly. Keep your status current, and clear it once everything is done and you're idle.`;
/** The shape every revival prompt has: what finished, each outcome, and the instruction that fits the batch. */
function revivalPrompt(header: string, summaryLine: string, blocks: readonly string[], completions: readonly { quietOrigin?: QuietWakeOrigin }[], standardInstruction: string): string {
  return [`${header} ${summaryLine}`, "", blocks.join("\n\n"), "", isAllQuietOrigin(completions) ? QUIET_REVIVAL_INSTRUCTION : standardInstruction].join("\n");
}

export function buildSubagentRevivalPrompt(
  completions: readonly SubagentCompletion[],
): string {
  const completionBlocks = completions.map(
      (completion) =>
        `${completion.status === "error" ? `Background task "${completion.title}" (${completion.subagentType}) failed:` : `Background task "${completion.title}" (${completion.subagentType}) finished:`}\n${completion.result}${completion.quietOrigin != null ? `\n${describeQuietOriginNote(completion.quietOrigin)}` : ""}`,
    ),
    summaryLine =
      completions.length === 1
        ? "A background task you started has finished."
        : `${completions.length} background tasks you started have finished.`,
    standardInstruction = `Pick the work back up: review the result(s), then either keep going or wrap up. If this result is genuinely new and relevant to the user, or the user asked to be told when this finished, tell them with a SendMessage. Lead with the concrete thing that finished, not a bare pronoun like "That" (they cannot see the background task). If it is stale, irrelevant, already handled, or a duplicate, and the user was not waiting on it, just stay silent and end the turn with no SendMessage rather than narrating it. Keep your status current, and clear it once everything is done and you're idle.`;
  return revivalPrompt("[A background task just completed]", summaryLine, completionBlocks, completions, standardInstruction);
}
/** One finished background command, as the revival prompt and the queue see it. */
export interface ShellCompletion {
  shellId: string;
  agentId: string;
  title: string;
  status: string;
  detail?: string;
  outputPath?: string;
  quietOrigin?: QuietWakeOrigin;
}
export function describeShellOutcome(status: string): string {
  return status === "success"
    ? "finished"
    : status === "aborted"
      ? "was stopped"
      : "failed";
}
export function buildShellRevivalPrompt(
  completions: readonly ShellCompletion[],
): string {
  const commandBlocks = completions.map((completion) => {
      const lines = [
        `Background command "${completion.title}" ${describeShellOutcome(completion.status)}.`,
      ];
      if (completion.detail) lines.push(completion.detail);
      if (completion.outputPath)
        lines.push(`Full output: ${completion.outputPath}`);
      if (completion.quietOrigin != null)
        lines.push(describeQuietOriginNote(completion.quietOrigin));
      return lines.join("\n");
    }),
    summaryLine =
      completions.length === 1
        ? "A command you started in the background has finished."
        : `${completions.length} commands you started in the background have finished.`,
    standardInstruction = `Pick the work back up: check the result (read the output file if you need the full logs), then either keep going or wrap up. If this result is genuinely new and relevant to the user, or the user asked to be told when this finished, tell them with a SendMessage. Lead with the concrete thing that finished, not a bare pronoun like "That" (they cannot see the background task). If it is stale, irrelevant, already handled, or a duplicate, and the user was not waiting on it, just stay silent and end the turn with no SendMessage rather than narrating it. Keep your status current, and clear it once everything is done and you're idle.`;
  return revivalPrompt("[A background command just completed]", summaryLine, commandBlocks, completions, standardInstruction);
}
/** Run the revivals queued for one conversation, one batch at a time, until its queue is empty. */
async function drainRevivals<TCompletion>(options: {
  readonly conversationId: string;
  readonly canExecute: boolean;
  readonly revivingIds: Set<string>;
  readonly pendingByConversation: Map<string, TCompletion[]>;
  readonly clearSettledWake: (completion: TCompletion) => void;
  readonly run: (completions: TCompletion[]) => Promise<void>;
}): Promise<void> {
  const { conversationId, canExecute, revivingIds, pendingByConversation } = options;
  if (!canExecute || revivingIds.has(conversationId)) return;
  revivingIds.add(conversationId);
  try {
    while ((pendingByConversation.get(conversationId)?.length ?? 0) > 0) {
      const completions = pendingByConversation.get(conversationId) ?? [];
      pendingByConversation.delete(conversationId);
      for (const completion of completions) options.clearSettledWake(completion);
      await options.run(completions);
    }
  } finally {
    revivingIds.delete(conversationId);
  }
}

export class CompletionRevivals {
  readonly pendingSubagentCompletions = new Map<string, SubagentCompletion[]>();
  readonly revivingSubagentAgentIds = new Set<string>();
  readonly pendingShellCompletions = new Map<string, ShellCompletion[]>();
  readonly revivingShellAgentIds = new Set<string>();

  constructor(readonly tm: TranscriptManagerLike) {}

  handleBackgroundSubagentCompletion(completion: SubagentCompletion): void {
    if (this.tm.sessions.deletedAgentIds.has(completion.parentAgentId)) {
      this.tm.telemetry.reportSubagentRevival({
        parentAgentId: completion.parentAgentId,
        outcome: "dropped",
        completionCount: 1,
        subagentType: completion.subagentType,
        subagentAgentId: completion.subagentAgentId,
        reason: "agent_deleted",
      });
      return;
    }
    const pending = this.pendingSubagentCompletions.get(completion.parentAgentId) ?? [];
    if (pending.some(item => item.subagentAgentId === completion.subagentAgentId)) return;
    pending.push(completion);
    this.pendingSubagentCompletions.set(completion.parentAgentId, pending);
    void this.reviveForSubagentCompletions(completion.parentAgentId);
  }

  async reviveForSubagentCompletions(agentId: string): Promise<void> {
    await drainRevivals<SubagentCompletion>({
      conversationId: agentId,
      canExecute: this.tm.execution.canExecute,
      revivingIds: this.revivingSubagentAgentIds,
      pendingByConversation: this.pendingSubagentCompletions,
      clearSettledWake: completion => this.tm.pendingWakes.clearSettledPendingWake({
        agentId,
        kind: completion.subagentType === "slate-agent" ? "cloud-agent" : "subagent",
        workId: completion.subagentAgentId,
      }),
      run: async completions => {
        const result = await this.runSubagentRevival(agentId, completions);
        this.tm.telemetry.reportSubagentRevival({
          parentAgentId: agentId,
          ...result,
          completionCount: completions.length,
          subagentType: completions[0]?.subagentType,
          isQuietOrigin: isAllQuietOrigin(completions),
        });
      },
    });
  }

  async runSubagentRevival(
    agentId: string,
    completions: readonly SubagentCompletion[],
  ): Promise<Record<string, unknown>> {
    if (completions.length === 0) return { outcome: "delivered" };
    if (!this.tm.execution.canExecute) return { outcome: "dropped", reason: "no_runner" };
    const resolution = await this.tryResolveBackgroundSession(agentId);
    if (resolution === null) return { outcome: "dropped", reason: "session_unavailable" };
    const session = resolution.session;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    let result: Record<string, unknown> = { outcome: "delivered" };
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.markBackgroundRevivalActive(session);
        try {
          const runResult = await runner.run(buildSubagentRevivalPrompt(completions), this.revivalRunOptions(session));
          await this.tm.roster.emitAgentUpdate(session.id);
          result = this.subagentOutcome(runResult, session);
        } catch (error) {
          this.reportRevivalError(session, "Background task follow-up failed", error);
          result = { outcome: "dropped", reason: "error" };
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "subagent-revival" },
    );
    return result;
  }

  handleBackgroundShellCompletion(completion: ShellCompletion): void {
    const enqueued = this.tm.pendingWakes.enqueuePendingWake(
      this.pendingShellCompletions,
      completion.agentId,
      [completion],
    );
    if (!enqueued) {
      this.tm.telemetry.reportShellRevival({
        conversationId: completion.agentId,
        outcome: "dropped",
        completionCount: 1,
        isQuietOrigin: completion.quietOrigin != null,
        reason: "agent_gone",
      });
      return;
    }
    void this.reviveForShellCompletions(completion.agentId);
  }

  async reviveForShellCompletions(agentId: string): Promise<void> {
    await drainRevivals<ShellCompletion>({
      conversationId: agentId,
      canExecute: this.tm.execution.canExecute,
      revivingIds: this.revivingShellAgentIds,
      pendingByConversation: this.pendingShellCompletions,
      clearSettledWake: completion => this.tm.pendingWakes.clearSettledPendingWake({
        agentId,
        kind: "shell",
        workId: completion.shellId,
      }),
      run: async completions => { await this.runShellRevival(agentId, completions); },
    });
  }
  async runShellRevival(
    agentId: string,
    completions: readonly ShellCompletion[],
  ): Promise<void> {
    if (completions.length === 0) return;
    const report = (outcome: string, extras: Record<string, unknown> = {}) =>
      this.tm.telemetry.reportShellRevival({
        conversationId: agentId,
        outcome,
        completionCount: completions.length,
        isQuietOrigin: isAllQuietOrigin(completions),
        ...extras,
      });
    if (!this.tm.execution.canExecute) return report("dropped", { reason: "no_runner" });
    const resolution = await this.tryResolveBackgroundSession(agentId);
    if (resolution === null) {
      report("dropped", { reason: "session_unavailable" });
      return;
    }
    const session = resolution.session;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.markBackgroundRevivalActive(session);
        try {
          const runResult = await runner.run(buildShellRevivalPrompt(completions), this.revivalRunOptions(session));
          this.reportShellOutcome(runResult, session, report);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.reportRevivalError(session, "Background command follow-up failed", error);
          report("dropped", { reason: "error" });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "shell-revival" },
    );
  }

  /** Resolve the conversation the revival runs in; null means the session could not be opened at all. */
  private async tryResolveBackgroundSession(agentId: string): Promise<{ readonly session: any } | null> {
    try {
      return { session: await this.tm.sessions.resolveBackgroundSession(agentId) };
    } catch {
      return null;
    }
  }

  /** Mark this conversation's request as the background revival, rather than as a user request. */
  private markBackgroundRevivalActive(session: any): void {
    this.tm.turnRuntime.activeRequestPrompts.delete(session.id);
    this.tm.turnRuntime.activeRequestSources.set(session.id, "background-revival");
  }

  /** What a revival turn is asked with: hidden, silence allowed, and any unanswered questions carried over. */
  private revivalRunOptions(session: any): Record<string, unknown> {
    return {
      hidden: true,
      isSilenceAllowed: true,
      autoReviewEpoch: "continue",
      ...this.tm.widgetResponses.collectUnansweredQuestionPrompts(session),
    };
  }

  /** How a finished subagent revival is reported, and what it leaves for the upgrade resume. */
  private subagentOutcome(runResult: any, session: any): Record<string, unknown> {
    if (runResult.aborted) return { outcome: "superseded" };
    if (runResult.quiescedForUpgrade === true) {
      this.tm.upgradeResume.markAgentResumePendingForQuiescedRevival(session);
      return { outcome: "dropped", reason: "quiesced" };
    }
    return { outcome: "delivered", sentMessageCount: runResult.sentMessageCount };
  }

  /** How a finished shell revival is reported, and what it leaves for the upgrade resume. */
  private reportShellOutcome(runResult: any, session: any, report: (outcome: string, extras?: Record<string, unknown>) => void): void {
    if (runResult.aborted) report("superseded");
    else if (runResult.quiescedForUpgrade === true) {
      this.tm.upgradeResume.markAgentResumePendingForQuiescedRevival(session);
      report("dropped", { reason: "quiesced" });
    } else report("delivered", { sentMessageCount: runResult.sentMessageCount });
  }

  /** Report a revival that failed: the agent error first, then the tray error a person can act on. */
  private reportRevivalError(session: any, title: string, error: unknown): void {
    const requestId = this.tm.runLifecycle.lastRequestIdBySession.get(session.id);
    this.tm.telemetry.reportAgentError({
      source: "background_followup",
      conversationId: session.id,
      requestId,
      error: classifyAgentError(error),
      detail: slateErrorDetail(error),
    });
    this.tm.trayErrors.pushError({
      agentId: session.id,
      title,
      ...describeAgentRunError(error),
    });
  }
}
