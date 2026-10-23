/**
 * Deciding when a transcript run may start.
 *
 * Runs are admitted one at a time per agent by default, a run that was asked for while another holds the slot is queued
 * rather than dropped, and a queued run that was cancelled is removed before it starts.
 */
import { realClock, type Clock, type Disposable } from "./transcript-hub.ts";

export type RunLane = "user" | "agent" | "background";
export interface RunTask {
  lane: RunLane;
  source: string;
  enqueuedAtMs: number;
  acceptedAtMs?: number;
  ackToken?: string;
  task(): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  promise: Promise<void>;
}
interface ActiveRun {
  queued: RunTask;
  startedAtMs: number;
  runGeneration: number;
  settledSignal: Promise<void>;
  markDone(): void;
  phase: "running" | "interrupted";
}
interface RunQueue {
  pendingUser: RunTask[];
  pendingAgent: RunTask[];
  pendingBackground: RunTask[];
  active: ActiveRun | null;
  generationCount: number;
  abandoned: Set<Promise<void>>;
  watchdogTimer?: Disposable;
  graceTimer?: Disposable;
}
export interface SchedulerOptions {
  watchdogMs: number;
  watchdogGraceMs: number;
  interruptWedgedRun(agentId: string): boolean;
  telemetry: {
    onAccepted(event: Record<string, any>): void;
    onDequeued(event: Record<string, any>): void;
    onWatchdog(event: Record<string, any>): void;
  };
  onRunStart?(agentId: string): void;
}

export function takeNextUserTask<T extends { source: string }>(
  pending: T[],
): T | undefined {
  if (pending.length === 0) return undefined;
  const preferred = pending.findIndex((queued) => queued.source !== "group-member");
  return pending.splice(preferred === -1 ? 0 : preferred, 1)[0];
}

export class SlateRunScheduler {
  readonly queues = new Map<string, RunQueue>();
  private isDisposed = false;

  constructor(
    readonly options: SchedulerOptions,
    readonly clock: Clock = realClock,
  ) {}

  enqueue(
    agentId: string,
    task: () => Promise<void>,
    taskOptions: {
      lane: RunLane;
      source: string;
      acceptedAtMs?: number;
      ackToken?: string;
    },
  ): Promise<void> {
    const queue = this.ensureQueue(agentId);
    let finishResolve!: () => void;
    let finishReject!: (error: unknown) => void;
    const finishPromise = new Promise<void>((res, rej) => {
      finishResolve = res;
      finishReject = rej;
    });
    const queued: RunTask = {
      lane: taskOptions.lane,
      source: taskOptions.source,
      enqueuedAtMs: this.clock.now(),
      ...(taskOptions.acceptedAtMs == null
        ? {}
        : { acceptedAtMs: taskOptions.acceptedAtMs }),
      ...(taskOptions.ackToken == null ? {} : { ackToken: taskOptions.ackToken }),
      task,
      resolve: finishResolve,
      reject: finishReject,
      promise: finishPromise,
    };
    if (queued.lane === "user") queue.pendingUser.push(queued);
    else if (queued.lane === "agent") queue.pendingAgent.push(queued);
    else queue.pendingBackground.push(queued);
    let pendingAhead =
      queue.pendingUser.length +
      queue.pendingAgent.length +
      queue.pendingBackground.length -
      1;
    if (queued.lane === "user") pendingAhead = queue.pendingUser.length - 1;
    else if (queued.lane === "agent")
      pendingAhead = queue.pendingUser.length + queue.pendingAgent.length - 1;
    this.options.telemetry.onAccepted({
      agentId,
      lane: queued.lane,
      source: queued.source,
      position: (queue.active == null ? 0 : 1) + pendingAhead,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
      hasActive: queue.active != null,
    });
    this.armWatchdogTimer(agentId, queue);
    void Promise.resolve().then(() => this.pump(agentId));
    return finishPromise;
  }

  async drain(agentId: string): Promise<void> {
    const queue = this.queues.get(agentId);
    if (queue == null) return;
    const waiters = [
      ...(queue.active == null ? [] : [queue.active.settledSignal]),
      ...queue.abandoned,
      ...queue.pendingUser.map((queued) => queued.promise),
      ...queue.pendingAgent.map((queued) => queued.promise),
      ...queue.pendingBackground.map((queued) => queued.promise),
    ];
    await Promise.allSettled(waiters);
  }

  getDiagnostics(): Array<Record<string, unknown>> {
    const now = this.clock.now();
    const rows: Array<Record<string, unknown>> = [];
    for (const [agentId, queue] of this.queues) {
      const depthUser = queue.pendingUser.length;
      const depthAgent = queue.pendingAgent.length;
      const depthBackground = queue.pendingBackground.length;
      if (
        depthUser === 0 &&
        depthAgent === 0 &&
        depthBackground === 0 &&
        queue.active == null
      )
        continue;
      rows.push({
        agentId,
        depthUser,
        depthAgent,
        depthBackground,
        depthTotal:
          depthUser +
          depthAgent +
          depthBackground +
          (queue.active == null ? 0 : 1),
        ...(queue.pendingUser[0] == null
          ? {}
          : {
              oldestPendingUserAgeMs: now - queue.pendingUser[0].enqueuedAtMs,
            }),
        ...(queue.active == null
          ? {}
          : {
              active: {
                lane: queue.active.queued.lane,
                source: queue.active.queued.source,
                runtimeMs: now - queue.active.startedAtMs,
                phase: queue.active.phase,
              },
            }),
      });
    }
    return rows;
  }

  getActiveLane(agentId: string): RunLane | undefined {
    return this.queues.get(agentId)?.active?.queued.lane;
  }

  dispose(): void {
    this.isDisposed = true;
    for (const queue of this.queues.values()) this.disarmTimers(queue);
  }

  private ensureQueue(agentId: string): RunQueue {
    const existingQueue = this.queues.get(agentId);
    if (existingQueue != null) return existingQueue;
    const newQueue: RunQueue = {
      pendingUser: [],
      pendingAgent: [],
      pendingBackground: [],
      active: null,
      generationCount: 0,
      abandoned: new Set(),
    };
    this.queues.set(agentId, newQueue);
    return newQueue;
  }

  private pump(agentId: string): void {
    if (this.isDisposed) return;
    const queue = this.queues.get(agentId);
    if (queue == null || queue.active != null) return;
    const dequeued =
      queue.pendingUser.length > 0
        ? takeNextUserTask(queue.pendingUser)
        : (queue.pendingAgent.shift() ?? queue.pendingBackground.shift());
    if (dequeued == null) {
      this.disarmTimers(queue);
      return;
    }
    let markDone!: () => void;
    const settledSignal = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const runningRun: ActiveRun = {
      queued: dequeued,
      startedAtMs: this.clock.now(),
      runGeneration: ++queue.generationCount,
      settledSignal,
      markDone,
      phase: "running",
    };
    queue.active = runningRun;
    this.options.telemetry.onDequeued({
      agentId,
      lane: dequeued.lane,
      source: dequeued.source,
      queueWaitMs: runningRun.startedAtMs - dequeued.enqueuedAtMs,
      ...(dequeued.acceptedAtMs == null
        ? {}
        : { acceptedToRunMs: runningRun.startedAtMs - dequeued.acceptedAtMs }),
      jumpedBackground:
        dequeued.lane === "background" ? 0 : queue.pendingBackground.length,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
    });
    this.disarmTimers(queue);
    this.armWatchdogTimer(agentId, queue);
    this.options.onRunStart?.(agentId);
    let workPromise: Promise<void>;
    try {
      workPromise = dequeued.task();
    } catch (error) {
      workPromise = Promise.reject(error);
    }
    void workPromise.then(
      () => {
        this.onTaskSettled(agentId, queue, runningRun);
        markDone();
      },
      (error) => {
        this.onTaskSettled(agentId, queue, runningRun, { error });
        markDone();
      },
    );
  }

  private onTaskSettled(
    agentId: string,
    queue: RunQueue,
    active: ActiveRun,
    taskFailure?: { error: unknown },
  ): void {
    if (taskFailure == null) active.queued.resolve();
    else active.queued.reject(taskFailure.error);
    if (queue.active?.runGeneration !== active.runGeneration) {
      this.options.telemetry.onWatchdog({
        agentId,
        stage: "late_settle",
        activeLane: active.queued.lane,
        activeSource: active.queued.source,
        activeRuntimeMs: this.clock.now() - active.startedAtMs,
      });
      return;
    }
    queue.active = null;
    this.disarmTimers(queue);
    this.pump(agentId);
  }

  private queuedBehindActiveMs(queue: RunQueue): number | null {
    const firstUser = queue.pendingUser[0];
    const active = queue.active;
    return firstUser == null || active == null
      ? null
      : this.clock.now() - Math.max(firstUser.enqueuedAtMs, active.startedAtMs);
  }
  private armWatchdogTimer(agentId: string, queue: RunQueue): void {
    if (
      this.isDisposed ||
      queue.watchdogTimer != null ||
      queue.graceTimer != null
    )
      return;
    const queuedAge = this.queuedBehindActiveMs(queue);
    if (queuedAge == null) return;
    queue.watchdogTimer = this.clock.schedule(
      Math.max(0, this.options.watchdogMs - queuedAge),
      () => {
        delete queue.watchdogTimer;
        this.tripWatchdogTimer(agentId, queue);
      },
    );
  }
  private disarmTimers(queue: RunQueue): void {
    queue.watchdogTimer?.dispose();
    queue.graceTimer?.dispose();
    delete queue.watchdogTimer;
    delete queue.graceTimer;
  }
  private tripWatchdogTimer(agentId: string, queue: RunQueue): void {
    if (this.isDisposed) return;
    const active = queue.active;
    const firstUser = queue.pendingUser[0];
    const queuedAge = this.queuedBehindActiveMs(queue);
    if (active == null || firstUser == null || queuedAge == null) return;
    if (queuedAge < this.options.watchdogMs) {
      this.armWatchdogTimer(agentId, queue);
      return;
    }
    let interruptAccepted = false;
    try {
      interruptAccepted = this.options.interruptWedgedRun(agentId);
    } catch {}
    active.phase = "interrupted";
    this.options.telemetry.onWatchdog({
      agentId,
      stage: "trip",
      activeLane: active.queued.lane,
      activeSource: active.queued.source,
      activeRuntimeMs: this.clock.now() - active.startedAtMs,
      waitingUserAgeMs: this.clock.now() - firstUser.enqueuedAtMs,
      interrupted: interruptAccepted,
    });
    queue.graceTimer = this.clock.schedule(this.options.watchdogGraceMs, () => {
      delete queue.graceTimer;
      this.releaseWedgedRun(agentId, queue, active);
    });
  }
  private releaseWedgedRun(
    agentId: string,
    queue: RunQueue,
    active: ActiveRun,
  ): void {
    if (this.isDisposed || queue.active?.runGeneration !== active.runGeneration) return;
    const waitingHead = queue.pendingUser[0];
    this.options.telemetry.onWatchdog({
      agentId,
      stage: "escape",
      activeLane: active.queued.lane,
      activeSource: active.queued.source,
      activeRuntimeMs: this.clock.now() - active.startedAtMs,
      ...(waitingHead == null
        ? {}
        : { waitingUserAgeMs: this.clock.now() - waitingHead.enqueuedAtMs }),
      ...(active.queued.ackToken == null
        ? {}
        : { ackToken: active.queued.ackToken }),
    });
    active.queued.resolve();
    queue.abandoned.add(active.settledSignal);
    void active.settledSignal.then(() => queue.abandoned.delete(active.settledSignal));
    queue.active = null;
    this.pump(agentId);
  }
}