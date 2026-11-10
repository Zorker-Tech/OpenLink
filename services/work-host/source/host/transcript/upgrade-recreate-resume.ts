/** Resuming the work an update interrupted.

 * An update asks every running turn to stop at a safe point and marks what still owes a continuation; a recreate then
 * brings those conversations back, carries the wakes that were waiting across the rebuild, and tells each one what it
 * was doing so it can pick the work up rather than start it again. */
import { isRecreateWakeCarryDisabled } from "./pending-wake-rearm.ts";
import {
  coercePendingWakeMarkers,
  type DurablePendingWakeMarker,
} from "./slate-pending-wake-store.ts";
import { describeAgentRunError } from "./agent-run-error.ts";
import { classifyAgentError } from "./turn-runtime.ts";
import { slateErrorDetail } from "../ports/telemetry.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

/** The sentence every resumed prompt opens with. */
const UPDATE_INTERRUPTED = "[A background system update restarted your environment and interrupted"
/** What every resumed turn is told: where it is, and that nothing reaches the user without a message. */
const RESUME_TAIL = "You've been resumed with your full conversation intact. Continue exactly where you left off and finish what you were doing. If your previous step already completed an action, do NOT repeat it — just carry on from there. Remember: nothing reaches the user unless it's inside a SendMessage."
/** What a routine run is told about staying quiet. */
const ROUTINE_QUIET_TAIL = "This is still that routine's own run — nobody is waiting on it, so if its saved instruction says to stay quiet when there's nothing to report, ending with no SendMessage remains a valid outcome.]"
/** What a background follow-up is told about staying quiet. */
const REVIVAL_QUIET_TAIL = "This follow-up was your own background wake — nobody is waiting on a reply, so if the results above your interruption point carry nothing genuinely new for the user, ending with no SendMessage remains a valid outcome.]"

export function buildUpgradeResumePrompt(source: string): string {
  if (source === "automation") return `${UPDATE_INTERRUPTED} a scheduled routine run mid-task. ${RESUME_TAIL} ${ROUTINE_QUIET_TAIL}`;
  if (source === "background-revival") return `${UPDATE_INTERRUPTED} one of your background-work follow-ups mid-delivery. ${RESUME_TAIL} ${REVIVAL_QUIET_TAIL}`;
  return `${UPDATE_INTERRUPTED} you mid-task. ${RESUME_TAIL}]`;
}

export interface UpgradeResumeMarker {
  agentId: string;
  markedAtMs: number;
  source?: string;
  automationId?: string;
  automationRunId?: string;
}

/** A session an upgrade can mark, as much as the marker needs. */
type ResumeSession = { readonly id: string }

/** The marker for one agent's pending resume, with the automation fields only when they are set. */
function resumeMarkerFor(session: ResumeSession, source: string, options?: ResumeMarkerOptions): UpgradeResumeMarker {
  return {
    agentId: session.id,
    markedAtMs: Date.now(),
    source,
    ...(options?.automationId == null ? {} : { automationId: options.automationId }),
    ...(options?.automationRunId == null ? {} : { automationRunId: options.automationRunId }),
  }
}

/** The pending resume markers this host remembers. */
function pendingResumeMarkers(tm: TranscriptManagerLike): UpgradeResumeMarker[] {
  return tm.upgradeResumeStore?.listPending() ?? []
}

/** The agents the pending markers name, in the order they were written. */
function pendingResumeAgentIds(tm: TranscriptManagerLike): string[] {
  return pendingResumeMarkers(tm).map((marker) => marker.agentId)
}

/** Asks one session's runners to stop at a safe point before the update. */
function requestRunnerQuiesce(tm: TranscriptManagerLike, session: ResumeSession): void {
  tm.runnerRegistry.runners.get(session.id)?.requestQuiesceForUpgrade()
  tm.runnerRegistry.activeGroupMemberRunners.get(session.id)?.requestQuiesceForUpgrade()
}

/** Lets every runner continue after the update. */
function cancelRunnerQuiesce(tm: TranscriptManagerLike): void {
  for (const runner of tm.runnerRegistry.runners.values()) runner.cancelQuiesceForUpgrade()
  for (const runner of tm.runnerRegistry.activeGroupMemberRunners.values()) runner.cancelQuiesceForUpgrade()
}

/** The source a session's running turn says it came from. */
function resumeSourceFor(tm: TranscriptManagerLike, session: ResumeSession): string {
  return tm.turnRuntime.activeRequestSources.get(session.id) ?? "turn"
}

/** The source a pending marker is resumed as: a notification becomes a background revival. */
function resumedSourceFor(marker: UpgradeResumeMarker): string {
  if (marker.source === "notification") return "background-revival"
  return marker.source ?? "handoff-resume"
}

/** Whether a resumed source carries an acknowledgement obligation. */
function sourceWantsAck(source: string): boolean {
  return source === "turn" || source === "handoff-resume"
}

/** The automation a resumed run belongs to, when the source is an automation and it still exists. */
function automationForResume(session: { automations: { get(id: string): { id: string; name: string } | undefined } }, source: string, marker: UpgradeResumeMarker): { readonly id: string; readonly name: string } | null {
  if (source !== "automation" || marker.automationId == null) return null
  return session.automations.get(marker.automationId) ?? null
}

/** The options a resumed turn runs with: hidden, silent where the source allows it, and with its automation when it has one. */
function resumeRunOptions(automation: { readonly id: string; readonly name: string } | null, source: string, ackToken: string | undefined) {
  return {
    hidden: true,
    ackToken,
    isSilenceAllowed: source === "automation" || source === "background-revival",
    ...(automation == null ? {} : { automationWake: { id: automation.id, name: automation.name } }),
    requestSource: source,
  }
}

/** Reports a resume that failed: to telemetry, and to the tray the user sees. */
function reportResumeFailure(tm: TranscriptManagerLike, session: { id: string }, error: unknown): void {
  tm.telemetry.reportAgentError({
    source: "resume",
    conversationId: session.id,
    requestId: tm.runLifecycle.lastRequestIdBySession.get(session.id),
    error: classifyAgentError(error),
    detail: slateErrorDetail(error),
  })
  tm.trayErrors.pushError({
    agentId: session.id,
    title: "Agent failed to resume after host update",
    ...describeAgentRunError(error),
  })
}

/** Whether a pending wake is one a recreate carries across. */
function isCarryableWake(marker: DurablePendingWakeMarker): boolean {
  return marker.kind === "cloud-agent" || marker.kind === "shell"
}

/** The reporter a carried wake's outcome is described with. */
function wakeReportFor(tm: TranscriptManagerLike, marker: DurablePendingWakeMarker, now: number): (outcome: string, reason?: string) => void {
  return (outcome: string, reason?: string): void => {
    tm.telemetry.reportPendingWake({
      conversationId: marker.agentId,
      outcome,
      kind: marker.kind,
      workId: marker.workId,
      ageMs: now - marker.markedAtMs,
      ...(reason == null ? {} : { reason }),
      isQuietOrigin: marker.quietOrigin != null,
    })
  }
}

/** Why a carried wake cannot be rearmed here, when it cannot: someone else owns it, its agent is gone, or it is a group. */
function wakeSkipReason(tm: TranscriptManagerLike, marker: DurablePendingWakeMarker): string | undefined {
  if (tm.pendingWakeStore?.hasPending(marker.agentId, marker.kind, marker.workId) === true) return "locally_owned"
  if (tm.sessions.isAgentGone(marker.agentId)) return "agent_gone"
  if (tm.groupChat.isGroupAgentId(marker.agentId)) return "group_session"
  return undefined
}

/** The marker as it is persisted here: a shell wake says the recreate interrupted it. */
function carriedWakeFor(marker: DurablePendingWakeMarker): DurablePendingWakeMarker {
  return marker.kind === "shell" ? { ...marker, interruptedByRecreate: true } : marker
}

/** The session to resume for an agent, when it can still be resolved. */
async function resolveResumableSession(tm: TranscriptManagerLike, agentId: string): Promise<{ id: string; automations: { get(id: string): { id: string; name: string } | undefined } } | undefined> {
  try {
    return await tm.sessions.resolveBackgroundSession(agentId)
  } catch {
    return undefined
  }
}

/** Runs one resumed turn: the prompt, the automation it belongs to, and the reports around it. */
async function runResumedTurn(tm: TranscriptManagerLike, runner: { run(prompt: string, options: unknown): Promise<void> }, session: { id: string; automations: { get(id: string): { id: string; name: string } | undefined } }, resumedSource: string, ackToken: string | undefined, marker: UpgradeResumeMarker): Promise<void> {
  tm.turnRuntime.activeRequestSources.set(session.id, resumedSource);
  try {
    const automation = automationForResume(session, resumedSource, marker);
    await runner.run(buildUpgradeResumePrompt(resumedSource), resumeRunOptions(automation, resumedSource, ackToken));
    await tm.roster.emitAgentUpdate(session.id);
    tm.automationRuntime.emitAutomations(session);
  } catch (error) {
    reportResumeFailure(tm, session, error);
  } finally {
    tm.ackObligations.retireAckRunToken(session.id, ackToken);
    tm.runLifecycle.endSessionRun(session);
  }
}

/** What a shell command's user is told when the recreate interrupted it and it cannot report itself. */
const RECREATE_INTERRUPTED_SHELL_DETAIL = "The computer update that rebuilt this agent's computer interrupted this background command; the command's process did not survive the update, so it will never report a completion. Check its terminal output file for what it got through, and re-run it if the work still matters."

/** The turns that are running or reviving: each agent once, and the shell work as one. */
function outstandingTurnCount(tm: TranscriptManagerLike): number {
  const ids = new Set([
    ...tm.liveRunningAgentIds(),
    ...tm.backgroundWakes.revivingSubagentAgentIds,
    ...tm.backgroundWakes.revivingShellAgentIds,
  ])
  return ids.size + (tm.hasRunningBackgroundShellWork() ? 1 : 0)
}

/** The marker a resume starts from: the stored one for the agent, or a fresh one when the store lost it. */
function markerForResume(tm: TranscriptManagerLike, agentId: string): UpgradeResumeMarker {
  return pendingResumeMarkers(tm).find((marker) => marker.agentId === agentId) ?? { agentId, markedAtMs: Date.now() }
}

/** The optional automation a resume marker carries. */
type ResumeMarkerOptions = { readonly automationId?: string; readonly automationRunId?: string }

/** The agents a recreate resumes: the ones it was told about, and the ones the store still remembers. */
function recreateResumeIds(agentIds: readonly string[], tm: TranscriptManagerLike): string[] {
  return [...new Set([...agentIds, ...pendingResumeAgentIds(tm)])]
}

/** The marker for one agent, cleared from the store, or nothing when the agent is gone. */
function takeMarkerForResume(tm: TranscriptManagerLike, agentId: string): UpgradeResumeMarker | undefined {
  if (tm.sessions.isAgentGone(agentId)) return undefined
  const marker = markerForResume(tm, agentId)
  tm.upgradeResumeStore?.clear(agentId)
  return marker
}

/** The agents whose background follow-up is being revived. */
function revivedAgentCount(tm: TranscriptManagerLike): number {
  return tm.backgroundWakes.revivingSubagentAgentIds.size + tm.backgroundWakes.revivingShellAgentIds.size
}

/** The pending wakes a recreate should carry: the cloud-agent and shell ones, when carrying is enabled. */
function recreateCarryWakes(tm: TranscriptManagerLike): DurablePendingWakeMarker[] {
  if (tm.pendingWakeStore == null || isRecreateWakeCarryDisabled()) return []
  return tm.pendingWakeStore.listPending().filter(isCarryableWake)
}

export class UpgradeRecreateResume {
  private quiescingForUpgrade = false;

  constructor(readonly tm: TranscriptManagerLike) {}

  async quiesceForUpgrade(): Promise<{
    quiescing: true,
    runningTurns: number,
  }> {
    this.quiescingForUpgrade = true;
    this.tm.traceFlusher();
    for (const session of this.tm.runLifecycle.inFlightRunCounts.keys()) requestRunnerQuiesce(this.tm, session);
    return {
      quiescing: true,
      runningTurns: this.tm.runLifecycle.runningAgentIds().size,
    };
  }

  isQuiescingForUpgrade(): boolean {
    return this.quiescingForUpgrade;
  }

  markAllRunningAgentsForUpgradeResume(): void {
    for (const session of this.tm.runLifecycle.inFlightRunCounts.keys()) {
      const source = resumeSourceFor(this.tm, session);
      if (source === "background-revival") this.markAgentResumePendingForQuiescedRevival(session);
      else this.markAgentResumePending(session, source);
    }
  }

  markAgentResumePending(
    session: { id: string },
    source: string,
    options?: ResumeMarkerOptions,
  ): void {
    this.tm.upgradeResumeStore?.markPending(resumeMarkerFor(session, source, options));
  }

  markAgentResumePendingForQuiescedRevival(session: { id: string }): void {
    const store = this.tm.upgradeResumeStore;
    if (store == null) return;
    if (store.listPending().some((marker: UpgradeResumeMarker) => marker.agentId === session.id)) return;
    this.markAgentResumePending(session, "background-revival");
  }

  async resumeInterruptedUpgradeTurns(): Promise<void> {
    if (this.tm.upgradeResumeStore == null || !this.tm.execution.canExecute) return;
    const pending = pendingResumeMarkers(this.tm);
    if (pending.length === 0) return;
    this.tm.upgradeResumeStore.clearAll();
    for (const marker of pending) {
      if (!this.tm.sessions.isAgentGone(marker.agentId)) void this.resumeUpgradeAgent(marker);
    }
  }

  async resumeUpgradeAgent(marker: UpgradeResumeMarker): Promise<void> {
    const session = await resolveResumableSession(this.tm, marker.agentId);
    if (session === undefined) return;
    if (this.tm.groupChat.isGroupSession(session)) return;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    const resumedSource = resumedSourceFor(marker);
    const ackToken = sourceWantsAck(resumedSource) ? this.tm.ackObligations.mintAckRunToken(session.id) : undefined;
    await this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      () => runResumedTurn(this.tm, runner, session, resumedSource, ackToken, marker),
      { lane: "background", source: "upgrade-resume", ackToken },
    );
  }

  async quiesceForRecreate(): Promise<{
    quiescing: boolean;
    runningTurns: number;
    resumeAgentIds: string[];
    resumePendingWakes: DurablePendingWakeMarker[];
  }> {
    const { quiescing } = await this.tm.quiesceForUpgrade();
    const outstanding = outstandingTurnCount(this.tm);
    return {
      quiescing,
      runningTurns: outstanding,
      resumeAgentIds: this.listResumePendingAgentIds(),
      resumePendingWakes: this.listRecreateCarryPendingWakes(),
    };
  }

  listResumePendingAgentIds(): string[] {
    return pendingResumeAgentIds(this.tm);
  }

  listRecreateCarryPendingWakes(): DurablePendingWakeMarker[] {
    return recreateCarryWakes(this.tm);
  }

  hasCarryablePendingWake(): boolean {
    return this.listRecreateCarryPendingWakes().length > 0;
  }

  hasMidDrainRevival(): boolean {
    return revivedAgentCount(this.tm) > 0;
  }

  async resumeAfterRecreate(
    agentIds: readonly string[],
    carriedPendingWakes?: readonly unknown[],
  ): Promise<{ resumed: number }> {
    this.quiescingForUpgrade = false;
    cancelRunnerQuiesce(this.tm);
    const ids = recreateResumeIds(agentIds, this.tm);
    let resumed = 0;
    for (const agentId of ids) {
      const marker = takeMarkerForResume(this.tm, agentId);
      if (marker === undefined) continue;
      void this.resumeUpgradeAgent(marker);
      resumed += 1;
    }
    this.restoreCarriedPendingWakes(carriedPendingWakes);
    return { resumed };
  }

  restoreCarriedPendingWakes(carriedPendingWakes?: readonly unknown[]): void {
    if (carriedPendingWakes == null || carriedPendingWakes.length === 0) return;
    if (!this.tm.execution.canExecute || isRecreateWakeCarryDisabled()) return;
    const now = Date.now();
    for (const marker of coercePendingWakeMarkers(carriedPendingWakes)) {
      if (!isCarryableWake(marker)) continue;
      const report = wakeReportFor(this.tm, marker, now);
      const skipped = wakeSkipReason(this.tm, marker);
      if (skipped !== undefined) {
        report("rearm_skipped", skipped);
        continue;
      }
      const accepted = carriedWakeFor(marker);
      if (this.tm.pendingWakeStore?.markPending(accepted) !== true) report("persist_failed");
      report("carried");
      if (accepted.kind === "cloud-agent") {
        void this.tm.pendingWakes.rearmPendingWake(accepted, now, { successReason: "recreate_carry" });
      } else this.deliverRecreateInterruptedShellNotice(accepted, report);
    }
  }

  deliverRecreateInterruptedShellNotice(
    marker: DurablePendingWakeMarker,
    report: (outcome: string, reason?: string) => void,
  ): void {
    report("dropped_with_notice");
    this.tm.backgroundWakes.handleBackgroundShellCompletion({
      agentId: marker.agentId,
      shellId: marker.workId,
      title: marker.title ?? `Background command ${marker.workId}`,
      status: "aborted",
      detail: RECREATE_INTERRUPTED_SHELL_DETAIL,
      ...(marker.quietOrigin == null ? {} : { quietOrigin: marker.quietOrigin }),
    });
  }
}
