/**
 * Keeping the host's view of its agents in step.
 *
 * What the roster knows is pushed to the pieces that need it — which agent the attachments belong to, which agents are
 * running, the box's own reminders — and each of them is told only what changed.
 */

export interface FallbackAgentApi {
  setFallbackAgentId(agentId: string | null): void;
}

export interface RunningAgentsApi {
  liveRunningAgentIds(): Iterable<string>;
}

export interface BoxBusyApi {
  readonly diskPressureReminder: {
    enroll(agentIds: ReadonlySet<string>): void;
  };
  setBusy(isBusy: boolean): void;
}

export interface AgentSnapshotApi {
  readonly isEnabled: boolean;
  scheduleSnapshot(agentId: string): void;
}

export interface BoxStoreSnapshotApi {
  readonly isEnabled: boolean;
  scheduleStoreDbSnapshot(agentId: string): void;
}

export interface AgentSourceMapApi {
  getOrCreate(agentId: string): unknown;
}

export interface RosterApiLookup {
  api(id: "attachments"): FallbackAgentApi;
  api(id: "transcript"): RunningAgentsApi;
  api(id: "forever-box"): BoxBusyApi;
  api(id: "state-backstop"): AgentSnapshotApi;
  api(id: "box-store-sync"): BoxStoreSnapshotApi;
  api(id: "source-map"): AgentSourceMapApi;
}

export interface HostRosterBookkeeping {
  readonly latestActiveAgentId: string | null;
  readonly isBusy: boolean;
  readonly runningAgentIds: ReadonlySet<string>;
  apply(activeAgentId: string | null | undefined): void;
}

/** An agent that is nobody, and an empty name, are both "no agent": the roster holds one shape, not three. */
function normalize(activeAgentId: string | null | undefined): string | null {
  return activeAgentId != null && activeAgentId.length > 0 ? activeAgentId : null;
}

/** The agents that appeared between two readings of what is running. */
function startedSince(now: ReadonlySet<string>, before: ReadonlySet<string>): Set<string> {
  const started = new Set<string>();
  for (const agentId of now) if (!before.has(agentId)) started.add(agentId);
  return started;
}

/** The agents that were running before and are not any more. */
function finishedSince(now: ReadonlySet<string>, before: ReadonlySet<string>): Iterable<string> {
  const finished: string[] = [];
  for (const agentId of before) if (!now.has(agentId)) finished.push(agentId);
  return finished;
}

export function createHostRosterBookkeeping(extensions: RosterApiLookup): HostRosterBookkeeping {
  let latestActiveAgentId: string | null = null;
  let runningAgentIds = new Set<string>();
  let isBusy = false;

  return {
    get latestActiveAgentId() {
      return latestActiveAgentId;
    },

    get isBusy() {
      return isBusy;
    },

    // A copy, so that reading the roster cannot change it.
    get runningAgentIds() {
      return new Set(runningAgentIds);
    },

    apply(activeAgentId) {
      const active = normalize(activeAgentId);
      latestActiveAgentId = active;
      extensions.api("attachments").setFallbackAgentId(active);

      const previouslyRunning = runningAgentIds;
      runningAgentIds = new Set(extensions.api("transcript").liveRunningAgentIds());
      isBusy = runningAgentIds.size > 0;

      const foreverBox = extensions.api("forever-box");
      const started = startedSince(runningAgentIds, previouslyRunning);
      if (started.size > 0) foreverBox.diskPressureReminder.enroll(started);
      foreverBox.setBusy(isBusy);

      // Whoever has just stopped is snapshotted once its work is behind it — but only if this build takes snapshots.
      const stateBackstop = extensions.api("state-backstop");
      const boxStore = extensions.api("box-store-sync");
      if (stateBackstop.isEnabled || boxStore.isEnabled) {
        for (const agentId of finishedSince(runningAgentIds, previouslyRunning)) {
          stateBackstop.scheduleSnapshot(agentId);
          boxStore.scheduleStoreDbSnapshot(agentId);
        }
      }

      if (active != null) void extensions.api("source-map").getOrCreate(active);
    },
  };
}
