/** Telling the platform what a conversation looks like now.

 * Appended entries, an agent's own status, which roster are running and the profile a conversation is under are emittedAgent
 * from here, coalesced and de-duplicated so the same news is not sent twice, and bounded so a long conversation does not
 * become a long message. */
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

import { upsertAgentSummary } from "../../shared/agents/agent-summaries.ts";
import { ROSTER_REPLICA_KEY } from "../../shared/ordering.ts";
import { HostReplicaWriter } from "./replica-writer.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export interface SnapshotStamp {
  snapshotEpoch: string;
  snapshotSeq: number;
}

export type EmitAgentUpdateOutcome = "delta" | "full" | "failed";

export class RosterEmit {
  cachedAgentSummaries: any[] = [];
  readonly snapshotEpoch = randomUUID();
  readonly replicaWriter = new HostReplicaWriter(this.snapshotEpoch);
  rosterCacheSeeded = false;

  private snapshotSeq = 0;
  private workChain: Promise<void> = Promise.resolve();
  private fullRosterPending = false;
  private readonly pendingAgentIds = new Set<string>();
  private flushPromise: Promise<void> | null = null;

  constructor(
    readonly tm: TranscriptManagerLike,
    readonly emitter: EventEmitter,
  ) {}

  enqueueEmit<T>(task: () => Promise<T>): Promise<T> {
    const run = this.workChain.then(task, task);
    this.workChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  emitAgents(): Promise<void> {
    this.fullRosterPending = true;
    return this.scheduleCoalescedEmit();
  }

  emitAgentUpdate(agentId: string): Promise<void> {
    this.pendingAgentIds.add(agentId);
    return this.scheduleCoalescedEmit();
  }

  scheduleCoalescedEmit(): Promise<void> {
    if (this.flushPromise != null) return this.flushPromise;
    const flushing = (async () => {
      await this.tm.taskBoundary.settled();
      await this.enqueueEmit(async () => {
        this.flushPromise = null;
        const wantsFull = this.fullRosterPending;
        const queuedAgentIds = [...this.pendingAgentIds];
        this.fullRosterPending = false;
        this.pendingAgentIds.clear();
        try {
          if (wantsFull) {
            await this.runEmitAgents();
            return;
          }
          for (const agentId of queuedAgentIds) {
            if ((await this.runEmitAgentUpdate(agentId)) === "full") return;
          }
        } catch (cause) {
          console.error(
            "[transcript-manager] coalesced roster emit failed:",
            cause,
          );
        }
      });
    })();
    this.flushPromise = flushing;
    return flushing;
  }

  reserveSnapshotStamp(): SnapshotStamp {
    return {
      snapshotEpoch: this.snapshotEpoch,
      snapshotSeq: ++this.snapshotSeq,
    };
  }

  applySnapshotStamp<T extends object>(
    roster: readonly T[],
    snapshot: SnapshotStamp,
  ): Array<T & SnapshotStamp> {
    return roster.map((agent) => ({ ...agent, ...snapshot }));
  }

  finalizeSummaryForRpc<T extends object>(
    agentSummary: T,
    snapshot: SnapshotStamp,
  ): T & SnapshotStamp {
    const finalized =
      this.tm.runLifecycle.withRunStates([agentSummary])[0] ?? agentSummary;
    return { ...finalized, ...snapshot };
  }

  async runEmitAgents(): Promise<void> {
    if (this.tm.disposed) return;
    const activeSession = await this.tm.sessions.tryEnsureSession();
    const announcedAgentId =
      this.tm.sessions.getAnnouncedActiveAgentId() ?? activeSession?.id;
    const snapshot = this.reserveSnapshotStamp();
    const roster = this.applySnapshotStamp(
      this.tm.runLifecycle.withRunStates(
        await this.tm.sessionStore.listAgents(announcedAgentId),
      ),
      snapshot,
    );
    this.cachedAgentSummaries = roster;
    this.rosterCacheSeeded = true;
    this.emitter.emit("agents", {
      activeAgentId: announcedAgentId ?? "",
      agents: roster,
      ordered: this.replicaWriter.nextStamp(ROSTER_REPLICA_KEY),
      coverage: { kind: "complete-roster" },
    });
  }

  async buildAgentSummary(agentId: string): Promise<any | null> {
    const currentActiveId = this.tm.sessions.activeSession?.id;
    const announcedAgentId =
      this.tm.sessions.getAnnouncedActiveAgentId() ?? undefined;
    const liveSession =
      currentActiveId === agentId
        ? this.tm.sessions.activeSession
        : (this.tm.sessions.liveSessions.get(agentId) ?? null);
    let agentSummary: any | null = null;
    if (liveSession != null) {
      try {
        agentSummary = await this.tm.sessionStore.summarizeSession(
          liveSession,
          announcedAgentId,
        );
      } catch {
        agentSummary = null;
      }
    }
    if (agentSummary == null) {
      agentSummary = await this.tm.sessionStore.summarizeAgentById(
        agentId,
        announcedAgentId,
      );
    }
    if (agentSummary == null) return null;
    return this.tm.runLifecycle.withRunStates([agentSummary])[0] ?? agentSummary;
  }

  async runEmitAgentUpdate(agentId: string): Promise<EmitAgentUpdateOutcome> {
    if (this.tm.disposed) return "failed";
    try {
      if (!this.rosterCacheSeeded) {
        await this.runEmitAgents();
        return "full";
      }
      const activeSession = await this.tm.sessions.tryEnsureSession();
      if (activeSession == null) {
        await this.runEmitAgents();
        return "full";
      }
      const snapshot = this.reserveSnapshotStamp();
      const agentSummary = await this.buildAgentSummary(agentId);
      if (agentSummary == null) {
        await this.runEmitAgents();
        return "full";
      }
      const patchedRoster = upsertAgentSummary(this.cachedAgentSummaries, agentSummary);
      const reconciledRoster = this.tm.runLifecycle.withRunStates(patchedRoster);
      const siblingUpdated = reconciledRoster.some(
        (agent: any, index: number) =>
          agent.id !== agentId && agent !== patchedRoster[index],
      );
      if (siblingUpdated) {
        await this.runEmitAgents();
        return "full";
      }
      const emittedAgent =
        this.applySnapshotStamp(
          [reconciledRoster.find((agent: any) => agent.id === agentId) ?? agentSummary],
          snapshot,
        )[0] ?? agentSummary;
      this.cachedAgentSummaries = upsertAgentSummary(reconciledRoster, emittedAgent);
      this.emitter.emit("agent-upserted", {
        activeAgentId:
          this.tm.sessions.getAnnouncedActiveAgentId() ?? activeSession.id,
        agent: emittedAgent,
        ordered: this.replicaWriter.nextStamp(ROSTER_REPLICA_KEY),
      });
      return "delta";
    } catch (cause) {
      console.error(
        `[transcript-manager] incremental emit failed for ${agentId}; falling back to wantsFull emit:`,
        cause,
      );
      try {
        await this.runEmitAgents();
        return "full";
      } catch {
        return "failed";
      }
    }
  }
}
