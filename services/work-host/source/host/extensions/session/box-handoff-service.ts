import { randomUUID } from "node:crypto";

import { decideBoxHandBack } from "./box-handoff-decision.ts";
import type {
  BoxHandoffDeps,
  HandoffRequest,
  HandoffTrigger,
  PendingHandoff,
} from "./box-handoff-contracts.ts";
import { captureHandoffSnapshot } from "./box-handoff-snapshot.ts";

export {
  MAX_DOMAIN_LENGTH,
  SNAPSHOT_TIMEOUT_MS,
  type BoxHandoffDeps,
  type HandoffRequest,
  type HandoffTrigger,
  type PendingHandoff,
} from "./box-handoff-contracts.ts";
export { decideBoxHandBack } from "./box-handoff-decision.ts";

export class BoxHandoffService {
  private readonly pending = new Map<string, PendingHandoff>();

  constructor(readonly deps: BoxHandoffDeps) {}

  get(agentId: string): PendingHandoff | null {
    return this.pending.get(agentId) ?? null;
  }

  forget(agentId: string): void {
    this.pending.delete(agentId);
  }

  start(request: HandoffRequest):
    | { kind: "started"; requestId: string }
    | { kind: "already-pending"; requestId: string; instruction: string } {
    const active = this.pending.get(request.agentId);
    if (active !== undefined) {
      return { kind: "already-pending", requestId: active.requestId, instruction: active.instruction };
    }

    const requestId = randomUUID();
    this.pending.set(request.agentId, { requestId, instruction: request.instruction });
    this.deps.onStarted?.({ agentId: request.agentId, instruction: request.instruction });
    this.deps.onStatusChanged?.(request.agentId);
    void captureHandoffSnapshot(
      this.deps,
      request,
      requestId,
      (agentId, id) => this.pending.get(agentId)?.requestId === id,
      (agentId, id, snapshotDataUrl) => this.storeSnapshot(agentId, id, snapshotDataUrl),
    );
    return { kind: "started", requestId };
  }

  async end(agentId: string, trigger: HandoffTrigger): Promise<void> {
    const decision = decideBoxHandBack(this.pending.get(agentId), trigger);
    if (decision.kind === "none") return;

    this.pending.delete(agentId);
    await this.deps.onEnded?.({
      agentId,
      requestId: decision.requestId,
      resolution: decision.resolution,
      trigger: decision.trigger,
    });
    this.deps.onStatusChanged?.(agentId);
  }

  private storeSnapshot(agentId: string, requestId: string, snapshotDataUrl: string): void {
    const active = this.pending.get(agentId);
    if (active?.requestId !== requestId) return;
    this.pending.set(agentId, { ...active, snapshotDataUrl });
    this.deps.onStatusChanged?.(agentId);
  }
}
