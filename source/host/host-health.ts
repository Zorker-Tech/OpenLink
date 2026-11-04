/**
 * The activity visible to the host: turn owners, work that keeps a box occupied, and approvals awaiting a person.
 * Review-only pauses remain busy for clients, while the busy clock continues to describe executable work.
 */
export interface SlateHostHealth {
  readonly isBusy: boolean;
  readonly busyOnlyAwaitingApproval: boolean;
  readonly activeAgentId: string | null;
  readonly lastBusyAtMs: number;
}

export interface HostActivityReading {
  readonly activeAgentId: string | null;
  readonly runningTurnsBusy: boolean;
  readonly runningAgentIds: Iterable<string>;
  readonly approvalAgentIds: Iterable<string>;
  readonly hasRunningSubagents: boolean;
  readonly hasBackgroundWork: boolean;
  readonly sampledAtMs: number;
  readonly lastBusyAtMs: number;
}

/** Combine a point-in-time roster reading with work that is not represented by an active turn. */
export function readHostActivity(reading: HostActivityReading): SlateHostHealth {
  const runningAgents = new Set(reading.runningAgentIds);
  const approvals = new Set(reading.approvalAgentIds);
  const runningTurns = reading.runningTurnsBusy;
  const waitingOnApprovals = runningTurns
    && runningAgents.size > 0
    && !reading.hasRunningSubagents
    && [...runningAgents].every((agentId) => approvals.has(agentId));
  const isBusy = runningTurns || reading.hasBackgroundWork;
  const busyOnlyAwaitingApproval = runningTurns && !reading.hasBackgroundWork && waitingOnApprovals;

  return {
    isBusy,
    busyOnlyAwaitingApproval,
    activeAgentId: reading.activeAgentId,
    lastBusyAtMs: isBusy && !busyOnlyAwaitingApproval ? reading.sampledAtMs : reading.lastBusyAtMs,
  };
}
