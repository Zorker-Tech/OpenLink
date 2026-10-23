/** The automations a conversation has, and everything that can happen to them.

 * The runtime watches what a conversation's automations look like, writes down every change it notices with where it came
 * from, publishes what the interface should show, and hands what is asked of them — create, update, enable, delete, run
 * now — to the machinery that owns the store, the spend guard and the run itself. */
import {
  AUTOMATION_PROMPT_GUIDANCE_VERSION,
  AUTOMATION_UI_LIMIT,
  type AutomationRecord,
  type AutomationSpec,
} from "../automations/automation.ts";
import { stableAutomationId } from "../automations/automation-id.ts";
import {
  compileCronMatcher,
  computeNextRunAt,
  normalizeSchedule,
  parseEveryIntervalMs,
  wallClockOfInstant,
} from "../../shared/automation-schedule.ts";
import { isDeliveryOwed, REPLY_NUDGE_PROMPT } from "./turn-runtime.ts";
import { AutomationEventFires } from "./automation-event-fires.ts";
import {
  AutomationRunPath,
  type FireAutomationArgs,
  type FireAutomationOutcome,
} from "./automation-run-path.ts";
import {
  snapshotAutomations,
  diffAutomationAction,
  type AutomationSnapshot,
} from "./automation-snapshot.ts";
import { AutomationSpendGuardRuntime } from "./automation-spend-guard-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

type AutomationLifecycleSource =
  "agent" | "automations_ui" | "workflow_ui" | "spend_guard";
type AutomationAction =
  "created" | "updated" | "enabled" | "disabled" | "deleted";

function summarizeSchedule(
  schedule: string,
  timeZone: string | undefined,
  startMs: number,
): {
  scheduledFiresNext7Days: number;
  firesOnWeekend: boolean;
  firesOvernight: boolean;
} {
  const deadline = startMs + 7 * 24 * 60 * 60_000;
  const normalized = normalizeSchedule(schedule);
  const intervalMs = parseEveryIntervalMs(normalized);
  const cronMatcher =
    intervalMs == null ? compileCronMatcher(normalized) : null;
  const intervalFireCount =
    intervalMs == null
      ? undefined
      : Math.floor((deadline - startMs) / intervalMs);
  if (intervalMs != null && intervalMs < 60_000) {
    const count = intervalFireCount ?? 0;
    return {
      scheduledFiresNext7Days: count,
      firesOnWeekend: count > 0,
      firesOvernight: count > 0,
    };
  }
  let cursor = startMs;
  let count = 0;
  let firesOnWeekend = false;
  let firesOvernight = false;
  while (true) {
    const next =
      intervalMs != null
        ? cursor + intervalMs
        : cronMatcher != null
          ? computeNextRunAt(normalized, cursor, timeZone)
          : null;
    if (next == null || next > deadline || next <= cursor) break;
    const wall = wallClockOfInstant(next, cronMatcher?.timeZone ?? timeZone);
    count += 1;
    firesOnWeekend ||= wall.dayOfWeek === 0 || wall.dayOfWeek === 6;
    firesOvernight ||= wall.hour < 7 || wall.hour >= 22;
    cursor = next;
  }
  return {
    scheduledFiresNext7Days: intervalFireCount ?? count,
    firesOnWeekend,
    firesOvernight,
  };
}

export class AutomationRuntime {
  watchedAutomations: any;
  readonly lastKnownAutomations = new Map<
    string,
    Map<string, AutomationSnapshot>
  >();
  readonly automationLifecycleMutationChains = new Map<string, Promise<void>>();
  readonly spendGuard: AutomationSpendGuardRuntime;
  readonly eventFires: AutomationEventFires;
  readonly runPath: AutomationRunPath;

  constructor(readonly tm: TranscriptManagerLike) {
    this.spendGuard = new AutomationSpendGuardRuntime(tm, this);
    this.eventFires = new AutomationEventFires(tm);
    this.runPath = new AutomationRunPath(tm, this.spendGuard, this.eventFires);
  }

  get pendingEventFireBatches() {
    return this.eventFires.pendingEventFireBatches;
  }
  notifyAutomationConfigChanged(): void {
    this.tm.automationConfigChanged?.();
  }

  watchSessionAutomations(conversation: any): void {
    if (this.watchedAutomations === conversation.automations) return;
    this.watchedAutomations?.setOnChange(undefined);
    this.watchedAutomations = conversation.automations;
    this.seedKnownAutomations(conversation);
    conversation.automations.setOnChange(() => {
      void this.enqueueAutomationLifecycleMutation({
        agentId: conversation.id,
        mutation: () => {
          this.recordAutomationChangeEvents(conversation, "agent");
          this.emitAutomations(conversation);
          this.notifyAutomationConfigChanged();
        },
      });
    });
  }

  seedKnownAutomations(conversation: any): void {
    if (!this.lastKnownAutomations.has(conversation.id)) {
      this.lastKnownAutomations.set(
        conversation.id,
        snapshotAutomations(conversation.automations.listDefinitions()),
      );
    }
  }

  recordAutomationChangeEvents(
    conversation: any,
    source: AutomationLifecycleSource,
  ): void {
    if (this.tm.sessions.activeSession?.id !== conversation.id) return;
    const liveSnapshot = snapshotAutomations(conversation.automations.listDefinitions());
    const priorSnapshot = this.lastKnownAutomations.get(conversation.id);
    this.lastKnownAutomations.set(conversation.id, liveSnapshot);
    if (priorSnapshot == null) return;
    for (const [id, nextSnapshot] of liveSnapshot) {
      const oldSnapshot = priorSnapshot.get(id);
      const action: AutomationAction | null =
        oldSnapshot == null ? "created" : diffAutomationAction(oldSnapshot, nextSnapshot);
      if (action != null)
        this.emitAutomationChange({
          agentId: conversation.id,
          action,
          automationId: id,
          automationName: nextSnapshot.name,
          automation: nextSnapshot,
          source,
        });
    }
    for (const [id, oldSnapshot] of priorSnapshot) {
      if (!liveSnapshot.has(id))
        this.emitAutomationChange({
          agentId: conversation.id,
          action: "deleted",
          automationId: id,
          automationName: oldSnapshot.name,
          automation: oldSnapshot,
          source,
        });
    }
  }

  enqueueAutomationLifecycleMutation<T>(input: {
    agentId: string;
    mutation(): T | Promise<T>;
  }): Promise<T> {
    const priorSnapshot =
      this.automationLifecycleMutationChains.get(input.agentId) ??
      Promise.resolve();
    const mutationResult = priorSnapshot.then(input.mutation, input.mutation);
    const chainTail = mutationResult.then(
      () => undefined,
      () => undefined,
    );
    this.automationLifecycleMutationChains.set(input.agentId, chainTail);
    void chainTail.then(() => {
      if (this.automationLifecycleMutationChains.get(input.agentId) === chainTail)
        this.automationLifecycleMutationChains.delete(input.agentId);
    });
    return mutationResult;
  }

  enqueueAutomationMutation<T>(input: {
    agentId: string;
    activeMutation(conversation: any): T;
    inactiveMutation(): T;
  }): Promise<T> {
    return this.enqueueAutomationLifecycleMutation({
      agentId: input.agentId,
      mutation: () => {
        const currentSession = this.tm.sessions.activeSession;
        let nextSnapshot: T;
        if (currentSession?.id === input.agentId) {
          this.recordAutomationChangeEvents(currentSession, "agent");
          nextSnapshot = input.activeMutation(currentSession);
          this.recordAutomationChangeEvents(currentSession, "automations_ui");
        } else {
          const oldSnapshot = this.tm.sessionStore.listAgentAutomations(
            input.agentId,
          ) as AutomationRecord[];
          this.recordInactiveAutomationChanges({
            agentId: input.agentId,
            before: oldSnapshot,
            after: oldSnapshot,
            source: "agent",
          });
          nextSnapshot = input.inactiveMutation();
          this.recordInactiveAutomationChanges({
            agentId: input.agentId,
            before: oldSnapshot,
            after: nextSnapshot as AutomationRecord[],
            source: "automations_ui",
          });
        }
        this.publishAutomations(input.agentId, nextSnapshot);
        return nextSnapshot;
      },
    });
  }

  recordInactiveAutomationChanges(input: {
    agentId: string;
    before: AutomationRecord[];
    after: AutomationRecord[];
    source: AutomationLifecycleSource;
  }): void {
    const priorSnapshot =
      this.lastKnownAutomations.get(input.agentId) ??
      snapshotAutomations(input.before);
    const liveSnapshot = snapshotAutomations(input.after);
    this.lastKnownAutomations.set(input.agentId, liveSnapshot);
    for (const [id, automation] of liveSnapshot) {
      const previousEntry = priorSnapshot.get(id);
      const action: AutomationAction | null =
        previousEntry == null ? "created" : diffAutomationAction(previousEntry, automation);
      if (action != null)
        this.emitAutomationLifecycle({
          agentId: input.agentId,
          action,
          automation,
          source: input.source,
        });
    }
    for (const [id, automation] of priorSnapshot) {
      if (!liveSnapshot.has(id))
        this.emitAutomationLifecycle({
          agentId: input.agentId,
          action: "deleted",
          automation,
          source: input.source,
        });
    }
  }

  emitAutomationChange(input: {
    agentId: string;
    action: AutomationAction;
    automationId: string;
    automationName: string;
    automation: AutomationSnapshot;
    source: AutomationLifecycleSource;
  }): void {
    this.tm.emitTimelineEvent(input.agentId, {
      type: "automation-changed",
      action: input.action,
      automationId: input.automationId,
      automationName: input.automationName,
    });
    this.emitAutomationLifecycle(input);
  }

  emitAutomationLifecycle(input: {
    agentId: string;
    action: AutomationAction;
    automation: AutomationSnapshot;
    source: AutomationLifecycleSource;
  }): void {
    const now = Date.now();
    const schedule =
      input.automation.triggerType === "cron"
        ? summarizeSchedule(
            input.automation.schedule,
            this.tm.sessionStore.getUserTimeZone(),
            now,
          )
        : undefined;
    const ageMs = Math.max(0, now - input.automation.createdAt);
    const automationId = stableAutomationId({
      agentId: input.agentId,
      localId: input.automation.id,
    });
    this.tm.telemetry.reportAutomationLifecycle({
      conversationId: input.agentId,
      automationId,
      action: input.action,
      source: input.source,
      triggerType: input.automation.triggerType,
      ...(schedule == null ? {} : schedule),
      ageMs,
      recordedRunCount: input.automation.recordedRunCount,
    });
    this.tm.productAnalytics.trackEvent("slate.automation.lifecycle", {
      agent_id: input.agentId,
      automation_id: automationId,
      action: input.action,
      source: input.source,
      trigger_type: input.automation.triggerType,
      ...(schedule == null
        ? {}
        : {
            scheduled_fires_next_7_days: schedule.scheduledFiresNext7Days,
            fires_on_weekend: schedule.firesOnWeekend,
            fires_overnight: schedule.firesOvernight,
          }),
      age_ms: ageMs,
      recorded_run_count: input.automation.recordedRunCount,
      guidance_version: AUTOMATION_PROMPT_GUIDANCE_VERSION,
    });
  }

  emitAutomations(conversation: any): void {
    if (
      this.tm.sessions.activeSession?.id === conversation.id &&
      this.tm.shouldEmitAutomations()
    ) {
      this.publishAutomations(
        conversation.id,
        conversation.automations.list().slice(0, AUTOMATION_UI_LIMIT),
      );
    }
  }
  publishAutomations(agentId: string, automations: unknown): void {
    if (this.tm.shouldEmitAutomations())
      this.tm.roster.emitter.emit("automations", { agentId, automations });
  }
  subscribeAutomations(listener: (value: unknown) => void): () => void {
    this.tm.roster.emitter.on("automations", listener);
    return () => this.tm.roster.emitter.off("automations", listener);
  }

  async getAgentAutomations(agentId: string): Promise<AutomationRecord[]> {
    const currentSession = this.tm.sessions.activeSession;
    return currentSession?.id === agentId
      ? currentSession.automations.list().slice(0, AUTOMATION_UI_LIMIT)
      : this.tm.sessionStore.listAgentAutomations(agentId);
  }
  async listAllAutomations(): Promise<AutomationRecord[]> {
    return this.tm.sessionStore.listAllAutomations();
  }
  async listAllAutomationDefinitions(): Promise<AutomationRecord[]> {
    return this.tm.sessionStore.listAllAutomationDefinitions();
  }

  async setAgentAutomationEnabled(
    agentId: string,
    automationId: string,
    isEnabled: boolean,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (currentSession) => {
          currentSession.automations.setEnabled(automationId, isEnabled);
          return currentSession.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.setAgentAutomationEnabled(
            agentId,
            automationId,
            isEnabled,
          ),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }
  async createAgentAutomation(
    agentId: string,
    spec: AutomationSpec,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (currentSession) => {
          currentSession.automations.upsert(spec);
          return currentSession.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.createAgentAutomation(agentId, spec),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }
  async updateAgentAutomation(
    agentId: string,
    automationId: string,
    spec: AutomationSpec,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (currentSession) => {
          currentSession.automations.update(automationId, spec);
          return currentSession.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.updateAgentAutomation(
            agentId,
            automationId,
            spec,
          ),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }
  async deleteAgentAutomation(
    agentId: string,
    automationId: string,
  ): Promise<AutomationRecord[]> {
    try {
      return await this.enqueueAutomationMutation({
        agentId,
        activeMutation: (currentSession) => {
          currentSession.automations.remove(automationId);
          return currentSession.automations.list().slice(0, AUTOMATION_UI_LIMIT);
        },
        inactiveMutation: () =>
          this.tm.sessionStore.removeAgentAutomation(agentId, automationId),
      });
    } finally {
      this.notifyAutomationConfigChanged();
    }
  }

  async runAgentAutomationNow(
    agentId: string,
    automationId: string,
  ): Promise<void> {
    const currentSession = this.tm.sessions.activeSession;
    const automation =
      currentSession?.id === agentId
        ? currentSession.automations.get(automationId)
        : ((await this.tm.sessionStore.listAgentAutomations(agentId)).find(
            (entry: AutomationRecord) => entry.id === automationId,
          ) ?? null);
    if (automation != null)
      await this.fireAutomation({ agentId, automation, trigger: "manual" });
  }
  runServerScheduledAutomation(input: {
    agentId: string;
    automation: AutomationRecord;
    runUuid: string;
    scheduledForMs?: number;
  }): Promise<FireAutomationOutcome> {
    return this.fireAutomation({
      agentId: input.agentId,
      automation: input.automation,
      trigger: "schedule",
      runUuid: input.runUuid,
      ...(input.scheduledForMs === undefined
        ? {}
        : { scheduledForMs: input.scheduledForMs }),
    });
  }
  runAutomationForEvent(
    agentId: string,
    automation: AutomationRecord,
    event: Record<string, unknown>,
  ) {
    return this.eventFires.enqueueEventAutomationFire({
      agentId,
      automation,
      event,
    });
  }
  runServerAutomationForEvent(input: {
    agentId: string;
    automation: AutomationRecord;
    event: Record<string, unknown>;
    runUuid: string;
  }) {
    return this.eventFires.enqueueEventAutomationFire(input);
  }
  fireAutomation(input: FireAutomationArgs): Promise<FireAutomationOutcome> {
    return this.runPath.fireAutomation(input);
  }
  handleSpendGuardWidgetAnswer(input: any): Promise<string | null> {
    return this.spendGuard.handleWidgetAnswer(input);
  }
  async ensureHiddenTurnReply(runner: any): Promise<boolean> {
    const retry = await runner.run(REPLY_NUDGE_PROMPT, { hidden: true });
    return !retry.aborted && !isDeliveryOwed(retry);
  }
}
