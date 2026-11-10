/** Asking the user definitionsBefore their routines keep spending, and doing what they answered.

 * What the guard decided is turned into what the user sees — a card they guardAnswer, a reminder, routines paused — and their
 * guardAnswer is carried out: what to resume, what to leave paused, what to stop asking about; every one of those changes is
 * recorded the way the platform records an automation change, whether the conversation is on screen or not. */
import {
  SPEND_GUARD_SNOOZE_MS,
  buildSpendGuardNudgeWidget,
  buildSpendGuardPausedWidget,
  countAutomationRunsSince,
  evaluateAutomationSpendGuard,
  interpretSpendGuardAnswer,
  isSpendGuardCard,
  renderSpendGuardAnswerAck,
  renderSpendGuardNudgeReminder,
  type SpendGuardAnswer,
  type SpendGuardWidget,
} from "./slate-automation-spend-guard.ts";
import { allocateTranscriptEntryId } from "./transcript-entry-ids.ts";
import { getTranscript } from "./transcript-store.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";

export const SPEND_GUARD_ANSWER_OUTCOMES = {
  keep: { routines: "resume-guard-paused", snoozes: true, retiresGuard: false },
  resume: {
    routines: "resume-guard-paused",
    snoozes: true,
    retiresGuard: false,
  },
  optOut: {
    routines: "resume-guard-paused",
    snoozes: false,
    retiresGuard: true,
  },
  pause: {
    routines: "disable-every-enabled",
    snoozes: false,
    retiresGuard: false,
  },
  stayPaused: { routines: "leave-as-is", snoozes: false, retiresGuard: false },
} as const;
export const CLEARED_GUARD_STATE = {
  nudgedAtMs: null,
  snoozedUntilMs: null,
  optedOut: false,
  cardEntryIds: [] as string[],
  pausedAutomationIds: [] as string[],
};

interface GuardState {
  nudgedAtMs: number | null;
  snoozedUntilMs: number | null;
  optedOut: boolean;
  cardEntryIds: string[];
  pausedAutomationIds: string[];
}
interface GuardSession {
  id: string;
  automations: any;
  db: any;
}


/** Whether this conversation is the one on screen: the guard writes into the live transcript only then. */
function isOnScreenSession(guardSession: GuardSession, tm: TranscriptManagerLike): boolean {
  return tm.sessions.activeSession?.id === guardSession.id;
}

/** The guard state the guardSession keeps, in the shape the runtime works with. */
function guardStateOf(guardSession: GuardSession): GuardState {
  return guardSession.db.getAutomationSpendGuardState() as GuardState;
}

/** Records an automation change the way the platform records one, on screen or not. */
function recordAutomationChange(
  host: any,
  guardSession: GuardSession,
  onScreen: boolean,
  definitionsBefore: unknown,
  after: () => unknown,
  source: "agent" | "spend_guard",
): void {
  if (onScreen) host.recordAutomationChangeEvents(guardSession, source);
  else host.recordInactiveAutomationChanges({ agentId: guardSession.id, before: definitionsBefore, after: after(), source });
}

export function disableEveryEnabledRoutine(guardSession: GuardSession): string[] {
  const disabledIds: string[] = [];
  for (const automation of guardSession.automations.listDefinitions()) {
    if (automation.isEnabled) {
      guardSession.automations.setEnabled(automation.id, false);
      disabledIds.push(automation.id);
    }
  }
  return disabledIds;
}
export function reEnableGuardPausedRoutines(
  guardSession: GuardSession,
  ids: readonly string[],
): void {
  const resume = new Set(ids);
  for (const automation of guardSession.automations.listDefinitions()) {
    if (resume.has(automation.id) && !automation.isEnabled)
      guardSession.automations.setEnabled(automation.id, true);
  }
}

export class AutomationSpendGuardRuntime {
  constructor(
    readonly tm: TranscriptManagerLike,
    readonly host: any,
  ) {}

  async apply(
    guardSession: GuardSession,
    firing: { id: string },
  ): Promise<{ paused: boolean; reminder?: string }> {
    const nowMs = Date.now();
    const isFiringOff = () =>
      guardSession.automations.get(firing.id)?.isEnabled !== true;
    const decisionSummary = this.evaluate(guardSession, nowMs);
    switch (decisionSummary.decision) {
      case "user-active":
      case "opted-out":
      case "snoozed":
      case "below-thresholds":
        return { paused: isFiringOff() };
      case "awaiting-ack":
        this.issueCardIfNone(guardSession);
        return { paused: isFiringOff() };
      case "nudge":
        guardSession.db.setAutomationSpendGuardState({
          ...CLEARED_GUARD_STATE,
          nudgedAtMs: nowMs,
          cardEntryIds: [
            this.issueGuardCard(guardSession, buildSpendGuardNudgeWidget()),
          ],
        });
        return {
          paused: isFiringOff(),
          reminder: renderSpendGuardNudgeReminder({
            nowMs,
            lastViewedAtMs: decisionSummary.lastViewedAtMs,
            unreadCount: decisionSummary.unreadCount,
            firesSinceViewedCount: decisionSummary.firesSinceViewedCount,
            timeZone: this.tm.sessionStore.getUserTimeZone(),
          }),
        };
      case "pause":
        return {
          paused: (await this.pauseForAwayUser(guardSession)) || isFiringOff(),
        };
    }
  }

  evaluate(guardSession: GuardSession, nowMs: number) {
    const unreadState = guardSession.db.getUnreadState();
    const state = guardStateOf(guardSession);
    const firesSinceViewedCount = countAutomationRunsSince(
      guardSession.automations.listDefinitions(),
      unreadState.lastViewedAt,
    );
    return {
      decision: evaluateAutomationSpendGuard({
        nowMs,
        lastViewedAtMs: unreadState.lastViewedAt,
        unreadCount: unreadState.unreadCount,
        firesSinceViewedCount,
        nudgedAtMs: state.nudgedAtMs,
        snoozedUntilMs: state.snoozedUntilMs,
        optedOut: state.optedOut,
      }),
      lastViewedAtMs: unreadState.lastViewedAt,
      unreadCount: unreadState.unreadCount,
      firesSinceViewedCount,
    };
  }

  async pauseForAwayUser(guardSession: GuardSession): Promise<boolean> {
    let pausedIds: string[] = [];
    await this.runGuardTransition(guardSession, (existingState) => {
      if (this.evaluate(guardSession, Date.now()).decision !== "pause") return;
      pausedIds = disableEveryEnabledRoutine(guardSession);
      if (pausedIds.length === 0) return;
      const isPauseAlreadyOpen = existingState.pausedAutomationIds.length > 0;
      guardSession.db.setAutomationSpendGuardState({
        ...CLEARED_GUARD_STATE,
        nudgedAtMs: existingState.nudgedAtMs,
        pausedAutomationIds: [
          ...new Set([...existingState.pausedAutomationIds, ...pausedIds]),
        ],
        cardEntryIds: isPauseAlreadyOpen
          ? existingState.cardEntryIds
          : [
              ...existingState.cardEntryIds,
              this.issueGuardCard(guardSession, buildSpendGuardPausedWidget()),
            ],
      });
    });
    if (pausedIds.length === 0) return false;
    this.tm.automationConfigChanged?.();
    this.host.emitAutomations(guardSession);
    this.tm.trayErrors.pushError({
      agentId: guardSession.id,
      title: "Routines paused while you were away",
      detail:
        "This agent's routines kept running without anyone reading the results, so they were paused to avoid wasted spend. Re-enable them from the routine panel when you're back.",
      dedupeKey: `spend-guard-paused:${guardSession.id}`,
    });
    return true;
  }

  async handleWidgetAnswer(args: {
    agentId: string;
    entryId: string;
    value: string;
    onApplied?(acknowledgement: string): void;
  }): Promise<string | null> {
    const guardAnswer = interpretSpendGuardAnswer(args.value);
    if (guardAnswer == null || this.tm.sessions.isAgentGone(args.agentId))
      return null;
    const guardSession = (await this.tm.sessions.resolveBackgroundSession(
      args.agentId,
    )) as GuardSession;
    const nowMs = Date.now();
    let wasApplied = false;
    await this.runGuardTransition(guardSession, (existingState) => {
      if (
        !existingState.cardEntryIds.includes(args.entryId) ||
        !this.isHostIssuedCard(guardSession, args.entryId, args.value)
      )
        return;
      const effects = SPEND_GUARD_ANSWER_OUTCOMES[guardAnswer];
      let pausedIds: string[] = [];
      if (effects.routines === "resume-guard-paused")
        reEnableGuardPausedRoutines(guardSession, existingState.pausedAutomationIds);
      else if (effects.routines === "disable-every-enabled")
        pausedIds = [
          ...new Set([
            ...existingState.pausedAutomationIds,
            ...disableEveryEnabledRoutine(guardSession),
          ]),
        ];
      guardSession.db.setAutomationSpendGuardState({
        ...CLEARED_GUARD_STATE,
        snoozedUntilMs: effects.snoozes ? nowMs + SPEND_GUARD_SNOOZE_MS : null,
        optedOut: effects.retiresGuard,
        pausedAutomationIds: pausedIds,
        cardEntryIds: pausedIds.length > 0 ? existingState.cardEntryIds : [],
      });
      wasApplied = true;
    });
    if (!wasApplied) return null;
    const acknowledgement = renderSpendGuardAnswerAck(guardAnswer as SpendGuardAnswer);
    args.onApplied?.(acknowledgement);
    this.tm.automationConfigChanged?.();
    this.host.emitAutomations(guardSession);
    return acknowledgement;
  }

  issueCardIfNone(guardSession: GuardSession): void {
    const existingState = guardStateOf(guardSession);
    if (existingState.cardEntryIds.length > 0) return;
    guardSession.db.setAutomationSpendGuardState({
      ...existingState,
      cardEntryIds: [
        this.issueGuardCard(guardSession, buildSpendGuardNudgeWidget()),
      ],
    });
  }
  isHostIssuedCard(
    guardSession: GuardSession,
    entryId: string,
    value: string,
  ): boolean {
    const entry = this.readEntries(guardSession).find(
      (item) => item.id === entryId,
    ) as any;
    return (
      entry?.kind === "send-message" &&
      entry.message?.type === "widget" &&
      isSpendGuardCard(entry.message.widget as SpendGuardWidget, value)
    );
  }
  readEntries(guardSession: GuardSession): TranscriptEntry[] {
    return isOnScreenSession(guardSession, this.tm)
      ? getTranscript()
      : guardSession.db.getTranscriptEntries();
  }
  issueGuardCard(guardSession: GuardSession, widget: SpendGuardWidget): string {
    const onScreen = isOnScreenSession(guardSession, this.tm);
    const entry: TranscriptEntry = {
      kind: "send-message",
      id: allocateTranscriptEntryId(this.readEntries(guardSession), "send-message"),
      message: { type: "widget", widget },
      timestampMs: Date.now(),
    };
    if (onScreen) this.tm.appendEntry(entry);
    else {
      guardSession.db.appendTranscriptEntry(entry);
      this.tm.sessionStore.markSessionActivity(guardSession);
      void this.tm.roster.emitAgentUpdate(guardSession.id);
    }
    return entry.id;
  }
  runGuardTransition(
    guardSession: GuardSession,
    mutate: (existingState: GuardState) => void,
  ): Promise<unknown> {
    return this.host.enqueueAutomationLifecycleMutation({
      agentId: guardSession.id,
      mutation: () => {
        const definitionsBefore = guardSession.automations.listDefinitions();
        const onScreen = isOnScreenSession(guardSession, this.tm);
        this.recordPendingAgentEdits(guardSession, onScreen, definitionsBefore);
        mutate(guardSession.db.getAutomationSpendGuardState());
        this.recordGuardDelta(guardSession, onScreen, definitionsBefore);
      },
    });
  }
  recordPendingAgentEdits(
    guardSession: GuardSession,
    onScreen: boolean,
    definitionsBefore: unknown,
  ): void {
    recordAutomationChange(this.host, guardSession, onScreen, definitionsBefore, () => definitionsBefore, "agent");
  }
  recordGuardDelta(
    guardSession: GuardSession,
    onScreen: boolean,
    definitionsBefore: unknown,
  ): void {
    recordAutomationChange(this.host, guardSession, onScreen, definitionsBefore, () => guardSession.automations.listDefinitions(), "spend_guard");
  }
}
