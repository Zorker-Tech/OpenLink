import { createHash } from "node:crypto";
import {
  SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE,
  SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE,
  type SlateLocalToolRequest,
  type SlateLocalToolScope,
} from "../../../shared/local-tool-permission-machinery.ts";
import type {
  LocalToolRefusalAttempt,
  LocalToolRefusalEntry,
} from "./local-tool-permission-controller-contracts.ts";
import {
  SLATE_LOCAL_TOOL_FORGOTTEN_AGENT_MEMORY,
  SLATE_LOCAL_TOOL_REFUSAL_DIRECTION_WINDOW,
  SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT,
} from "./local-tool-permission-controller-contracts.ts";

function refusalKey(agentId: string, action: SlateLocalToolRequest["action"], target: string): string {
  const digest = createHash("sha256").update(target, "utf8").digest("hex");
  return `${agentId}\0${action}\0${digest}`;
}

export class LocalToolRefusalMemory {
  private readonly epochs = new Map<string, number>();
  private readonly refusals = new Map<string, LocalToolRefusalEntry>();
  private readonly saturatedAt = new Map<string, number>();
  private readonly standingGrantEpochs = new Map<string, number>();
  private readonly forgotten = new Set<string>();
  private observedPermission: string | undefined;

  directionEpoch(agentId: string): number {
    return this.epochs.get(agentId) ?? 0;
  }

  advanceDirection(agentId: string): number {
    const nextEpoch = this.directionEpoch(agentId) + 1;
    this.epochs.set(agentId, nextEpoch);
    this.forgotten.delete(agentId);
    return nextEpoch;
  }

  forgetAgent(agentId: string): void {
    this.epochs.delete(agentId);
    this.saturatedAt.delete(agentId);
    this.standingGrantEpochs.delete(agentId);
    for (const [key, entry] of this.refusals) {
      if (entry.agentId === agentId) this.refusals.delete(key);
    }

    this.forgotten.add(agentId);
    if (this.forgotten.size > SLATE_LOCAL_TOOL_FORGOTTEN_AGENT_MEMORY) {
      const oldest = this.forgotten.values().next();
      if (!oldest.done) this.forgotten.delete(oldest.value);
    }
  }

  refusalFor(scope: SlateLocalToolScope, request: SlateLocalToolRequest): string | undefined {
    if (this.forgotten.has(scope.agentId)) return SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE;

    const epoch = scope.directionEpoch ?? this.directionEpoch(scope.agentId);
    const saturationEpoch = this.saturatedAt.get(scope.agentId);
    if (saturationEpoch !== undefined && epoch <= saturationEpoch) return SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE;

    const refusal = this.refusals.get(refusalKey(scope.agentId, request.action, request.target));
    return refusal !== undefined && refusal.directionEpoch >= epoch
      ? SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE
      : undefined;
  }

  predatesStandingGrant(scope: SlateLocalToolScope | undefined): boolean {
    if (scope === undefined) return false;
    const grantEpoch = this.standingGrantEpochs.get(scope.agentId);
    const requestEpoch = scope.directionEpoch ?? this.directionEpoch(scope.agentId);
    return grantEpoch !== undefined && requestEpoch < grantEpoch;
  }

  isStalePending(agentId: string, requestEpoch: number): boolean {
    return requestEpoch < this.directionEpoch(agentId);
  }

  notePermission(permission: string): { readonly clearsRefusals: boolean } {
    const widened = permission === "always" && this.observedPermission !== "always";
    const clearsRefusals = permission === "ask" && this.observedPermission === "never";
    this.observedPermission = permission;

    if (widened) {
      this.standingGrantEpochs.clear();
      for (const [agentId, epoch] of this.epochs) this.standingGrantEpochs.set(agentId, epoch);
    }
    if (clearsRefusals) this.refusals.clear();
    return { clearsRefusals };
  }

  rememberRefusal(attempt: LocalToolRefusalAttempt): void {
    const key = refusalKey(attempt.agentId, attempt.action, attempt.target);
    const previous = this.refusals.get(key);
    const latestEpoch = previous === undefined
      ? attempt.directionEpoch
      : Math.max(previous.directionEpoch, attempt.directionEpoch);
    this.refusals.set(key, { agentId: attempt.agentId, directionEpoch: latestEpoch });
    this.reclaimForAgent(attempt.agentId);
  }

  clearRefusalsForAgent(agentId: string): void {
    for (const [key, entry] of this.refusals) {
      if (entry.agentId === agentId) this.refusals.delete(key);
    }
  }

  clearRefusals(): void {
    this.refusals.clear();
  }

  retainedAgentIds(): string[] {
    return [
      ...new Set([
        ...this.epochs.keys(),
        ...this.saturatedAt.keys(),
        ...this.standingGrantEpochs.keys(),
        ...[...this.refusals.values()].map((entry) => entry.agentId),
      ]),
    ];
  }

  refusalCount(): number {
    return this.refusals.size;
  }

  private reclaimForAgent(agentId: string): void {
    const owned = [...this.refusals].filter(([, entry]) => entry.agentId === agentId);
    let held = owned.length;
    if (held <= SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT) return;

    const currentEpoch = this.directionEpoch(agentId);
    const removeAndSaturate = (key: string, entry: LocalToolRefusalEntry) => {
      this.refusals.delete(key);
      const previous = this.saturatedAt.get(entry.agentId);
      if (previous === undefined || entry.directionEpoch > previous) {
        this.saturatedAt.set(entry.agentId, entry.directionEpoch);
      }
      held -= 1;
    };

    for (const [key, entry] of owned) {
      if (held <= SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT) break;
      if (currentEpoch - entry.directionEpoch > SLATE_LOCAL_TOOL_REFUSAL_DIRECTION_WINDOW) {
        removeAndSaturate(key, entry);
      }
    }

    for (const [key, entry] of owned) {
      if (held <= SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT) break;
      if (this.refusals.has(key)) removeAndSaturate(key, entry);
    }
  }
}
