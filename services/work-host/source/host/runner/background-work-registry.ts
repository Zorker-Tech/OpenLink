/** A registry of running work plus the wakeups and completions awaiting delivery. */
import type { BackgroundWakeup, BackgroundWorkFilter, BackgroundWorkRecord } from "./background-work-contracts.ts";

export class RevivingBackgroundWorkRegistry {
  readonly #records = new Map<string, BackgroundWorkRecord>();
  readonly #pendingWakeups: BackgroundWakeup[] = [];
  readonly #completed: BackgroundWakeup["payload"][] = [];
  readonly #quietSourceByWork = new Map<string, string>();

  constructor(
    readonly onShellCompletion?: (item: BackgroundWakeup["payload"], quietOrigin?: string) => void,
    readonly onShellWorkRegistered?: (record: BackgroundWorkRecord, quietOrigin?: string) => void,
    readonly onWorkSetChanged?: () => void,
  ) {}

  upsertWork(record: BackgroundWorkRecord): void {
    this.#records.set(record.id, record);
    this.onWorkSetChanged?.();
  }

  clearWork(id: string): BackgroundWorkRecord | undefined {
    const previous = this.#records.get(id);
    this.#records.delete(id);
    this.onWorkSetChanged?.();
    return previous;
  }

  abortWork(id: string): boolean {
    const current = this.#records.get(id);
    if (current === undefined) return false;
    current.abort?.();
    this.#records.delete(id);
    this.onWorkSetChanged?.();
    return true;
  }

  abortAllWork(filter: BackgroundWorkFilter = {}): number {
    const selected = this.listWork(filter);
    for (const item of selected) {
      this.#records.get(item.id)?.abort?.();
      this.#records.delete(item.id);
    }
    this.onWorkSetChanged?.();
    return selected.length;
  }

  hasRunningWork(filter: BackgroundWorkFilter = {}): boolean {
    return this.listWork(filter).some(item => item.state === "running");
  }

  listWork(filter: BackgroundWorkFilter = {}): BackgroundWorkRecord[] {
    return [...this.#records.values()].filter(item => filter.kind == null || item.kind === filter.kind);
  }

  enqueue(wakeup: BackgroundWakeup): void {
    const payload = wakeup.payload;
    if (payload.kind === "shell" && payload.reason !== "task_progress") {
      const quietOrigin = this.#quietSourceByWork.get(payload.taskId);
      this.#quietSourceByWork.delete(payload.taskId);
      this.onShellCompletion?.(payload, quietOrigin);
      return;
    }
    this.#pendingWakeups.push(wakeup);
  }

  pull(conversationId: string): BackgroundWakeup[] {
    return this.#pendingWakeups.filter(item => item.conversationId == null || item.conversationId === conversationId);
  }

  ack(ids: readonly string[]): void {
    const acknowledged = new Set(ids);
    for (let index = this.#pendingWakeups.length - 1; index >= 0; index -= 1) {
      if (acknowledged.has(this.#pendingWakeups[index]?.id ?? "")) this.#pendingWakeups.splice(index, 1);
    }
  }

  nack(_ids: readonly string[], _options?: unknown): void {}

  suppress(conversationId: string, id: string): void {
    for (let index = this.#pendingWakeups.length - 1; index >= 0; index -= 1) {
      const wakeup = this.#pendingWakeups[index];
      if (wakeup?.conversationId === conversationId && wakeup.id === id) this.#pendingWakeups.splice(index, 1);
    }
  }

  enqueueCompletion(completion: BackgroundWakeup["payload"]): void {
    this.#completed.push(completion);
  }

  drainCompletions(): BackgroundWakeup["payload"][] {
    return this.#completed.splice(0);
  }

  hasPendingCompletions(_conversationId: string): boolean {
    return this.#completed.length > 0;
  }

  markAwaitedCompletion(_taskId: string): void {}

  recordWorkOrigin(id: string, origin?: string): void {
    if (origin == null) this.#quietSourceByWork.delete(id);
    else this.#quietSourceByWork.set(id, origin);
  }

  forTurn(origin?: string) {
    return {
      upsertWork: (item: BackgroundWorkRecord) => {
        this.recordWorkOrigin(item.id, origin);
        this.upsertWork(item);
        if (item.kind === "shell" && item.state === "running") this.onShellWorkRegistered?.(item, origin);
      },
      clearWork: (id: string) => this.clearWork(id),
      abortWork: (id: string) => this.abortWork(id),
      hasRunningWork: (filter?: BackgroundWorkFilter) => this.hasRunningWork(filter),
      abortAllWork: (filter?: BackgroundWorkFilter) => this.abortAllWork(filter),
      listWork: (filter?: BackgroundWorkFilter) => this.listWork(filter),
      enqueue: (wakeup: BackgroundWakeup) => this.enqueue(wakeup),
      pull: (id: string) => this.pull(id),
      ack: (ids: readonly string[]) => this.ack(ids),
      nack: (ids: readonly string[], options?: unknown) => this.nack(ids, options),
      suppress: (conversationId: string, id: string) => this.suppress(conversationId, id),
      enqueueCompletion: (item: BackgroundWakeup["payload"]) => this.enqueueCompletion(item),
      drainCompletions: () => this.drainCompletions(),
      hasPendingCompletions: (id: string) => this.hasPendingCompletions(id),
      markAwaitedCompletion: (id: string) => this.markAwaitedCompletion(id),
    };
  }
}
