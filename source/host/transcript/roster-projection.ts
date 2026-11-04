/** What the platform is told a conversation looks like.

 * The roster a host keeps — which agents exist, how they are named, what they are doing and how far the user has read —
 * is projected into the shape the platform reads, with the ordering stamp that lets a reader put a later nextUpdate back in
 * its place and with anything stale left out rather than sent. */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  realClock,
  type Clock,
  type DebouncePolicy,
} from "../extensions/scheduling.ts";
import { isManagedSubagentConversationId } from "../../shared/agents/subagents.ts";
import { transcriptReplicaKey } from "../../shared/ordering.ts";
import { SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME } from "../runner/conversation-outline.ts";
import { mergeAsyncTasks } from "./async-task-union.ts";
import { ProfileWatch } from "./profile-watch.ts";
import { RosterEmit } from "./roster-emit.ts";
import { RosterSearch } from "./roster-search.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export const OUTLINE_STREAM_COALESCE_MS = 250;

interface OutlineUpdate {
  agentId: string;
  item: any;
}

export class RosterProjection {
  readonly emitter = new EventEmitter();
  readonly search: RosterSearch;
  readonly rosterSearch: RosterSearch;
  readonly profileWatch: ProfileWatch;
  readonly rosterEmit: RosterEmit;
  readonly lastKnownAgentNames: Map<string, string>;

  readonly subagentWorkSources = new Map<string, Set<any>>();
  readonly reportedSubagentParents = new Set<string>();
  readonly lastRunnerAsyncTasks = new Map<string, Map<any, any[]>>();

  outline: any[] = [];
  outlineAgentId: string | null = null;
  streamingAssistantOutlineId: string | undefined;
  streamingThinkingOutlineId: string | undefined;
  activeOutlineLoad: Promise<any[]> | null = null;
  outlineEpoch = 0;

  private queuedStreamFrame: OutlineUpdate | null = null;
  private streamOutlineFlush:
    (((...input: any[]) => void) & { dispose(): void }) | null = null;
  private streamClock: Clock = realClock;
  private lastFlushMonoMs = 0;

  constructor(readonly tm: TranscriptManagerLike) {
    this.rosterEmit = new RosterEmit(tm, this.emitter);
    this.profileWatch = new ProfileWatch(tm, this.emitter, this.rosterEmit);
    this.search = new RosterSearch(tm);
    this.rosterSearch = this.search;
    this.lastKnownAgentNames = this.profileWatch.lastKnownAgentNames;
  }

  get cachedAgentSummaries(): any[] {
    return this.rosterEmit.cachedAgentSummaries;
  }

  set cachedAgentSummaries(agents: any[]) {
    this.rosterEmit.cachedAgentSummaries = agents;
  }

  setOutlineStreamCoalescing(
    policy: DebouncePolicy,
    clock: Clock = realClock,
  ): void {
    this.streamOutlineFlush?.dispose();
    this.streamOutlineFlush = policy.wrap(() =>
      this.flushStreamOutlineUpdate(),
    );
    this.streamClock = clock;
    this.lastFlushMonoMs = clock.monotonicNow();
  }

  stopOutlineStreamCoalescing(): void {
    this.streamOutlineFlush?.dispose();
    this.streamOutlineFlush = null;
    this.queuedStreamFrame = null;
  }

  flushStreamOutlineUpdate(): void {
    const queued = this.queuedStreamFrame;
    if (queued == null) return;
    this.queuedStreamFrame = null;
    this.lastFlushMonoMs = this.streamClock.monotonicNow();
    this.emitter.emit("outline", {
      type: "updated",
      agentId: queued.agentId,
      item: queued.item,
    });
  }

  async listAgents(): Promise<any[]> {
    const conversation = await this.tm.sessions.tryEnsureSession();
    const announcedId =
      this.tm.sessions.getAnnouncedActiveAgentId() ?? conversation?.id;
    const stamp = this.rosterEmit.reserveSnapshotStamp();
    const agents = this.rosterEmit.applySnapshotStamp(
      this.tm.runLifecycle.withRunStates(
        await this.tm.sessionStore.listAgents(announcedId),
      ),
      stamp,
    );
    await this.rosterEmit.enqueueEmit(async () => {
      if (!this.rosterEmit.rosterCacheSeeded) {
        this.rosterEmit.cachedAgentSummaries = agents;
        this.rosterEmit.rosterCacheSeeded = true;
      }
    });
    return agents;
  }

  async countAgentsOnDisk(): Promise<number> {
    return (await this.tm.sessionStore.listAgents()).length;
  }

  async isAgentCapReached(): Promise<boolean> {
    return this.tm.sessionStore.isAgentCapReached();
  }

  searchAgents(...input: Parameters<RosterSearch["searchAgents"]>) {
    return this.search.searchAgents(...input);
  }

  searchMedia(...input: Parameters<RosterSearch["searchMedia"]>) {
    return this.search.searchMedia(...input);
  }

  listAgentsSync(): any[] {
    return this.rosterEmit.cachedAgentSummaries;
  }

  subscribeAgents(listener: (value: any) => void): () => void {
    this.emitter.on("agents", listener);
    return () => this.emitter.off("agents", listener);
  }

  subscribeAgentUpserted(listener: (value: any) => void): () => void {
    this.emitter.on("agent-upserted", listener);
    return () => this.emitter.off("agent-upserted", listener);
  }

  emitProfileChanged(
    ...input: Parameters<ProfileWatch["emitProfileChanged"]>
  ): void {
    this.profileWatch.emitProfileChanged(...input);
  }

  subscribeProfileChanged(
    ...input: Parameters<ProfileWatch["subscribeProfileChanged"]>
  ) {
    return this.profileWatch.subscribeProfileChanged(...input);
  }

  watchSessionProfile(
    ...input: Parameters<ProfileWatch["watchSessionProfile"]>
  ): void {
    this.profileWatch.watchSessionProfile(...input);
  }

  stopWatchingProfile(): void {
    this.profileWatch.stopWatchingProfile();
  }

  getAgentDisplayProfile(
    ...input: Parameters<ProfileWatch["getAgentDisplayProfile"]>
  ) {
    return this.profileWatch.getAgentDisplayProfile(...input);
  }

  resolveAgentProfile(
    ...input: Parameters<ProfileWatch["resolveAgentProfile"]>
  ) {
    return this.profileWatch.resolveAgentProfile(...input);
  }

  emitAgents(): Promise<void> {
    return this.rosterEmit.emitAgents();
  }

  emitAgentUpdate(agentId: string): Promise<void> {
    return this.rosterEmit.emitAgentUpdate(agentId);
  }

  reserveSnapshotStamp() {
    return this.rosterEmit.reserveSnapshotStamp();
  }

  finalizeSummaryForRpc<T extends object>(
    summary: T,
    stamp: Parameters<RosterEmit["finalizeSummaryForRpc"]>[1],
  ) {
    return this.rosterEmit.finalizeSummaryForRpc(summary, stamp);
  }

  subscribe(listener: (value: any) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  subscribeOutline(listener: (value: any) => void): () => void {
    this.emitter.on("outline", listener);
    return () => this.emitter.off("outline", listener);
  }

  subscribeSubagents(listener: (value: any) => void): () => void {
    this.emitter.on("subagents", listener);
    return () => this.emitter.off("subagents", listener);
  }

  subscribeAsyncTasks(listener: (value: any) => void): () => void {
    this.emitter.on("async-tasks", listener);
    return () => this.emitter.off("async-tasks", listener);
  }

  subscribeClientSideToolV2(listener: (value: any) => void): () => void {
    this.emitter.on("client-side-tool-v2", listener);
    return () => this.emitter.off("client-side-tool-v2", listener);
  }

  emitClientSideToolV2(value: unknown): void {
    this.emitter.emit("client-side-tool-v2", value);
  }

  async getSubagents(parentAgentId: string): Promise<any[]> {
    return (
      this.tm.runnerRegistry.runners.get(parentAgentId)?.listSubagents() ?? []
    );
  }

  async getAsyncTasks(parentAgentId: string): Promise<any[]> {
    return this.mergedAsyncTasks(parentAgentId);
  }

  mergedAsyncTasks(parentAgentId: string): any[] {
    if (this.tm.sessions.deletedAgentIds.has(parentAgentId)) return [];
    const liveRunner = this.tm.runnerRegistry.runners.get(parentAgentId);
    const liveUnion = [...(liveRunner?.listAsyncTasks() ?? [])];
    const seen = new Set(
      liveUnion.map((task: any) => `${task.kind}\0${task.id}`),
    );
    for (const [taskSource, tasks] of this.lastRunnerAsyncTasks.get(
      parentAgentId,
    ) ?? []) {
      if (taskSource === liveRunner) continue;
      for (const task of tasks) {
        const identity = `${task.kind}\0${task.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        liveUnion.push(task);
      }
    }
    const wakeMarkers =
      this.tm.pendingWakeStore
        ?.listPending()
        .filter((marker: any) => marker.agentId === parentAgentId) ?? [];
    return mergeAsyncTasks(liveUnion, wakeMarkers);
  }

  async getConversationOutline(agentId: string): Promise<any[]> {
    if (isManagedSubagentConversationId(agentId)) {
      let items: any[] = [];
      for (const taskSource of this.tm.runnerRegistry.runners.values()) {
        if (!taskSource.hasSubagent(agentId)) continue;
        try {
          items = await taskSource.getSubagentOutline(agentId);
        } catch {
          items = [];
        }
        break;
      }
      this.emitOutline({ type: "snapshot", agentId, items });
      return items;
    }
    const conversation = await this.tm.sessions.ensureSession();
    if (conversation.id === agentId) {
      const epoch = this.outlineEpoch;
      const items = await this.loadActiveOutline(conversation);
      if (this.outlineEpoch === epoch) {
        this.emitOutline({ type: "snapshot", agentId, items });
      }
      return items;
    }
    let items: any[] = [];
    try {
      items = await this.tm.sessionStore.getAgentOutline(agentId);
    } catch {
      items = [];
    }
    this.emitOutline({ type: "snapshot", agentId, items });
    return items;
  }

  async loadActiveOutline(conversation: any): Promise<any[]> {
    if (this.outlineAgentId === conversation.id) {
      return this.activeOutlineLoad == null
        ? this.outline
        : this.activeOutlineLoad;
    }
    this.outline = [];
    this.outlineAgentId = conversation.id;
    this.streamingAssistantOutlineId = undefined;
    this.streamingThinkingOutlineId = undefined;
    const epoch = this.outlineEpoch;
    const loadPromise = (async () => {
      const persisted = await this.tm.sessionStore
        .getSessionOutline(conversation)
        .catch(() => []);
      if (
        this.outlineEpoch === epoch &&
        this.tm.sessions.activeSession?.id === conversation.id &&
        this.outlineAgentId === conversation.id
      ) {
        this.outline = [...persisted, ...this.outline];
        return this.outline;
      }
      return persisted;
    })();
    this.activeOutlineLoad = loadPromise;
    const items = await loadPromise;
    if (this.activeOutlineLoad === loadPromise) this.activeOutlineLoad = null;
    return items;
  }

  invalidateActiveOutline(): void {
    this.flushStreamOutlineUpdate();
    this.outlineEpoch += 1;
    this.activeOutlineLoad = null;
    this.outline = [];
    this.outlineAgentId = null;
    this.streamingAssistantOutlineId = undefined;
    this.streamingThinkingOutlineId = undefined;
  }

  appendOutlineItem(item: any): void {
    this.outline = [...this.outline, item];
    if (this.outlineAgentId != null) {
      this.emitOutline({
        type: "appended",
        agentId: this.outlineAgentId,
        item,
      });
    }
  }

  updateOutlineItem(
    id: string,
    nextUpdate: (item: any) => any,
    options?: { coalesce?: boolean },
  ): any | null {
    let refreshed: any | null = null;
    this.outline = this.outline.map((item) => {
      if (item.id !== id) return item;
      refreshed = nextUpdate(item);
      return refreshed;
    });
    if (refreshed == null || this.outlineAgentId == null) return refreshed;
    if (options?.coalesce === true && this.streamOutlineFlush != null) {
      if (
        this.queuedStreamFrame != null &&
        this.queuedStreamFrame.item.id !== id
      )
        this.flushStreamOutlineUpdate();
      this.queuedStreamFrame = {
        agentId: this.outlineAgentId,
        item: refreshed,
      };
      if (
        this.streamClock.monotonicNow() -
          this.lastFlushMonoMs >=
        OUTLINE_STREAM_COALESCE_MS
      )
        this.flushStreamOutlineUpdate();
      else this.streamOutlineFlush();
      return refreshed;
    }
    this.emitOutline({
      type: "updated",
      agentId: this.outlineAgentId,
      item: refreshed,
    });
    return refreshed;
  }

  applyAgentUpdateToOutline(nextUpdate: any): void {
    if (this.outlineAgentId == null) return;
    if (nextUpdate.type === "text-delta" || nextUpdate.type === "thinking-delta") {
      if (nextUpdate.text.length === 0) return;
      const isThinking = nextUpdate.type === "thinking-delta";
      if (isThinking) this.streamingAssistantOutlineId = undefined;
      else this.streamingThinkingOutlineId = undefined;
      const id = isThinking
        ? this.streamingThinkingOutlineId
        : this.streamingAssistantOutlineId;
      if (id != null) {
        const refreshed = this.updateOutlineItem(
          id,
          (item) =>
            item.kind === (isThinking ? "thinking" : "assistant-text")
              ? { ...item, text: `${item.text}${nextUpdate.text}` }
              : item,
          { coalesce: true },
        );
        if (refreshed != null) return;
      }
      const item = {
        kind: isThinking ? "thinking" : "assistant-text",
        id: randomUUID(),
        text: nextUpdate.text,
      };
      if (isThinking) this.streamingThinkingOutlineId = item.id;
      else this.streamingAssistantOutlineId = item.id;
      this.appendOutlineItem(item);
      return;
    }
    if (nextUpdate.type === "tool-call") {
      if (nextUpdate.name === SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME) return;
      this.streamingAssistantOutlineId = undefined;
      this.streamingThinkingOutlineId = undefined;
      const refreshed = this.updateOutlineItem(nextUpdate.id, (item) =>
        item.kind === "tool-call"
          ? {
              ...item,
              name: nextUpdate.name,
              status: nextUpdate.status,
              ...(nextUpdate.summary == null ? {} : { summary: nextUpdate.summary }),
            }
          : item,
      );
      if (refreshed == null) {
        this.appendOutlineItem({
          kind: "tool-call",
          id: nextUpdate.id,
          name: nextUpdate.name,
          status: nextUpdate.status,
          ...(nextUpdate.summary == null ? {} : { summary: nextUpdate.summary }),
        });
      }
      return;
    }
    if (nextUpdate.type === "send-message") {
      this.streamingAssistantOutlineId = undefined;
      this.streamingThinkingOutlineId = undefined;
      this.appendOutlineItem({
        kind: "send-message",
        id: randomUUID(),
        message: nextUpdate.message,
        timestampMs: nextUpdate.timestampMs,
      });
      return;
    }
    if (nextUpdate.type === "turn-ended") {
      this.streamingAssistantOutlineId = undefined;
      this.streamingThinkingOutlineId = undefined;
    }
  }

  emit(frame: any, owningAgentId?: string): void {
    const stamped = this.withOwningAgentId(frame, owningAgentId);
    this.emitter.emit("event", this.withOrderedStamp(stamped));
    if (frame.type === "cleared" && typeof stamped.agentId === "string") {
      const reset = this.tm.clientSideToolV2.reset(stamped.agentId);
      if (reset != null) this.emitClientSideToolV2(reset);
    }
  }

  withOrderedStamp(frame: any): any {
    const agentId =
      frame.type === "snapshot" ? frame.activeAgentId : frame.agentId;
    if (agentId == null || agentId.length === 0) return frame;
    const ordered = this.rosterEmit.replicaWriter.nextStamp(
      transcriptReplicaKey(agentId),
    );
    if (frame.type !== "snapshot") return { ...frame, ordered };
    return {
      ...frame,
      ordered,
      coverage: {
        kind: "transcript-live-range",
        fromSequence: 1,
        throughSequence: ordered.sequence,
      },
    };
  }

  withOwningAgentId(frame: any, owningAgentId?: string): any {
    if (frame.type === "snapshot") return frame;
    const agentId = owningAgentId ?? this.tm.sessions.inMemoryTranscriptAgentId;
    return agentId == null || agentId.length === 0
      ? frame
      : { ...frame, agentId };
  }

  emitOutline(frame: any): void {
    this.flushStreamOutlineUpdate();
    this.emitter.emit("outline", frame);
  }

  emitAsyncTasks(taskSource: any, frame: any): void {
    if (this.tm.sessions.deletedAgentIds.has(frame.parentAgentId)) return;
    const perRunnerMap =
      this.lastRunnerAsyncTasks.get(frame.parentAgentId) ?? new Map();
    if (frame.tasks.length === 0) perRunnerMap.delete(taskSource);
    else perRunnerMap.set(taskSource, frame.tasks);
    if (perRunnerMap.size === 0)
      this.lastRunnerAsyncTasks.delete(frame.parentAgentId);
    else this.lastRunnerAsyncTasks.set(frame.parentAgentId, perRunnerMap);
    this.emitter.emit("async-tasks", {
      parentAgentId: frame.parentAgentId,
      tasks: this.mergedAsyncTasks(frame.parentAgentId),
    });
  }

  emitAsyncTasksForAgent(agentId: string): void {
    this.emitter.emit("async-tasks", {
      parentAgentId: agentId,
      tasks: this.mergedAsyncTasks(agentId),
    });
  }

  emitSubagents(workSource: any, frame: any): void {
    const parentAgentId = frame.parentAgentId;
    const sourceSet = this.subagentWorkSources.get(parentAgentId) ?? new Set();
    sourceSet.add(workSource);
    this.subagentWorkSources.set(parentAgentId, sourceSet);
    const isRunningNow = this.liveSubagentParentIds().has(parentAgentId);
    const wasRunning = this.reportedSubagentParents.has(parentAgentId);
    if (isRunningNow) this.reportedSubagentParents.add(parentAgentId);
    else this.reportedSubagentParents.delete(parentAgentId);
    try {
      this.emitter.emit("subagents", frame);
    } catch (error) {
      this.tm.productAnalytics.trackEvent("slate.subagent.fanout_failed", {
        agent_id: parentAgentId,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    if (isRunningNow !== wasRunning) void this.emitAgentUpdate(parentAgentId);
  }

  liveSubagentParentIds(): Set<string> {
    const parentIds = new Set<string>();
    for (const [agentId, sourceSet] of this.subagentWorkSources) {
      for (const workSource of sourceSet) {
        if (workSource.hasRunningSubagents()) parentIds.add(agentId);
        else sourceSet.delete(workSource);
      }
      if (sourceSet.size === 0) this.subagentWorkSources.delete(agentId);
    }
    return parentIds;
  }

  forgetAgentSubagentWork(agentId: string): void {
    this.subagentWorkSources.delete(agentId);
    this.reportedSubagentParents.delete(agentId);
  }
}
