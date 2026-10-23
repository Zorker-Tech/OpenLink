/**
 * One attempt at a streamed turn.
 *
 * An attempt is waited for up to the deadline the model's first token implies, and a stream that broke, an overloaded
 * provider or a stall is retried with the policy the platform resolved — while anything the platform cannot recognize
 * is left for the turn to report rather than retried forever.
 */
import { FirstTokenStallError, isRetryableProviderError, isTransientStreamError, resolveFirstTokenStallDeadlineMs, resolveOverloadStreamRetryPolicy, runWithTransientRetry, shouldRetryTurnAttempt, type RetryPolicy } from "./transient-stream-error.ts";

export interface StreamAttemptHost<Context, Checkpoint, State> {
  readonly ctx: { readonly canceled: boolean; withCancel(): readonly [Context, (reason: { intentional: boolean; reason: string }) => void] };
  readonly hidden: boolean;
  readonly transientStreamRetry?: RetryPolicy;
  setStreamOutputProduced(value: boolean): void; getStreamOutputProduced(): boolean;
  persistCheckpoint(ctx: Context, checkpoint: Checkpoint, accepted: (persisted: Checkpoint) => void): Promise<void>;
  startStream(ctx: Context, resumeFrom: Checkpoint | undefined, persistIfCurrent: (ctx: Context, checkpoint: Checkpoint) => Promise<void>): Promise<State>;
  createDeadlineTimer(callback: () => void, stallDeadline: number): { cancel(): void; restart(): void };
  setDeadlineHooks(stopDeadline: () => void, restartDeadline: () => void): void;
  clearDeadlineHookIf(stopDeadline: () => void, restartDeadline: () => void): void;
  setTraceAttributes(attributes: Readonly<Record<string, number>>): void;
  emitRetrying(): void;
  reportTurnRetry(info: { outcome: "retried" | "exhausted" | "gave_up_ineligible"; attempt: number; maxAttempts: number; delayMs?: number; serverPaced?: boolean; error: unknown }): void;
}

export function createStreamAttempt<Context, Checkpoint, State>(host: StreamAttemptHost<Context, Checkpoint, State>) {
  let latestCheckpoint: Checkpoint | undefined, resumeStreamFrom: Checkpoint | undefined;
  const idleToken = {}, tokenRef: { value: object } = { value: idleToken };
  let retryCount = 0;

  const attemptStreamOnce = async (): Promise<State> => {
    host.setStreamOutputProduced(false); latestCheckpoint = undefined;
    const [attemptCtx, cancelAttempt] = host.ctx.withCancel();
    const attempt = {}; tokenRef.value = attempt;
    const isCurrentAttempt = (): boolean => tokenRef.value === attempt;
    const retireAttempt = (): void => { if (isCurrentAttempt()) tokenRef.value = idleToken; };
    const pendingWrites = new Set<Promise<void>>(); let writeFailure: unknown;
    const persistIfCurrent = async (ctx: Context, checkpoint: Checkpoint): Promise<void> => {
      if (!isCurrentAttempt()) return;
      const writeOperation = Promise.resolve().then(() => host.persistCheckpoint(ctx, checkpoint, (persisted) => { latestCheckpoint = persisted; }));
      pendingWrites.add(writeOperation);
      try { await writeOperation; } catch (error) { writeFailure ??= error; throw error; } finally { pendingWrites.delete(writeOperation); }
    };
    let streamPromise: Promise<State>;
    try { streamPromise = host.startStream(attemptCtx, resumeStreamFrom, persistIfCurrent); } catch (error) { retireAttempt(); throw error; }
    const stallBase = resolveFirstTokenStallDeadlineMs();
    if (stallBase <= 0) {
      try { const streamState = await streamPromise; if (writeFailure != null) throw writeFailure; return streamState; }
      catch (error) { throw writeFailure ?? error; } finally { retireAttempt(); }
    }
    const stallDeadline = stallBase * 2 ** retryCount;
    return new Promise<State>((resolve, reject) => {
      let isSettled = false, stallTaken = false;
      const handleStall = (): void => {
        if (isSettled || host.getStreamOutputProduced()) return;
        isSettled = true; stallTaken = true; retireAttempt(); cancelAttempt({ intentional: false, reason: "first-token stall" });
        void Promise.allSettled(pendingWrites).then((settledWrites) => reject(writeFailure ?? settledWrites.find((result) => result.status === "rejected")?.reason ?? new FirstTokenStallError(stallDeadline)));
      };
      const deadlineTimer = host.createDeadlineTimer(handleStall, stallDeadline);
      const stopDeadline = (): void => { isSettled = true; deadlineTimer.cancel(); host.clearDeadlineHookIf(stopDeadline, restartDeadline); };
      const restartDeadline = (): void => { if (!isSettled && !host.getStreamOutputProduced()) deadlineTimer.restart(); };
      host.setDeadlineHooks(stopDeadline, restartDeadline);
      void streamPromise.then((streamState) => { if (stallTaken) return; stopDeadline(); retireAttempt(); writeFailure == null ? resolve(streamState) : reject(writeFailure); }, (error) => { if (stallTaken) return; stopDeadline(); retireAttempt(); reject(writeFailure ?? error); });
    });
  };

  const automationPolicy = host.transientStreamRetry;
  const retryPolicy = automationPolicy ?? resolveOverloadStreamRetryPolicy();
  const automationIsRetryable = automationPolicy == null
    ? undefined
    : automationPolicy.isRetryable ?? isTransientStreamError;
  const runWithPolicy = async (): Promise<State> => retryPolicy.maxAttempts > 1 ? runWithTransientRetry(attemptStreamOnce, {
    ...retryPolicy,
    isRetryable: (error) => shouldRetryTurnAttempt({ error, canceled: host.ctx.canceled, streamOutputProduced: host.getStreamOutputProduced(), resumeCheckpointAvailable: latestCheckpoint != null, ...(automationIsRetryable == null ? {} : { automationIsRetryable }) }),
    onRetry: (info) => {
      retryCount = info.attempt;
      if (host.getStreamOutputProduced() && latestCheckpoint != null) resumeStreamFrom = latestCheckpoint;
      host.setTraceAttributes({ "slate.retry_count": info.attempt }); if (!host.hidden) host.emitRetrying();
      host.reportTurnRetry({ outcome: "retried", attempt: info.attempt, maxAttempts: retryPolicy.maxAttempts, delayMs: info.delayMs, serverPaced: info.serverPaced, error: info.error });
      automationPolicy?.onRetry?.(info);
    },
  }) : attemptStreamOnce();

  return { async run(): Promise<State> {
    try { return await runWithPolicy(); } catch (error) {
      if (!host.ctx.canceled) {
        const attempt = retryCount + 1;
        if (retryCount > 0 && retryCount >= retryPolicy.maxAttempts - 1) host.reportTurnRetry({ outcome: "exhausted", attempt, maxAttempts: retryPolicy.maxAttempts, error });
        else if (retryCount > 0 || isRetryableProviderError(error)) host.reportTurnRetry({ outcome: "gave_up_ineligible", attempt, maxAttempts: retryPolicy.maxAttempts, error });
      }
      throw error;
    }
  } };
}

export interface OuterStreamPersistence<Context, State> {
  readonly generation: number;
  runGeneration(): number;
  prepareCheckpointForPersistence(checkpoint: State): void;
  persistStepCheckpoint(context: Context, checkpoint: State): Promise<void>;
  noteCheckpoint?(checkpoint: State): void;
  persistFinalState(context: Context, checkpoint: State): Promise<void>;
  commitDiskPressureReminder(): void;
  releaseDiskPressureReminder(): void;
  noteAutomationStatusReminder?(): void;
  isAwaitingUserSelection(): boolean;
  isQuiescingForUpgrade(): boolean;
  markQuiescedForUpgrade(): void;
  cancelRun(cancellation: {
    readonly intentional: boolean;
    readonly reason: string;
  }): void;
}

export interface OuterStreamLifecycleInput<Context, State> {
  /** The real per-attempt startStream owner; action production stays outside. */
  readonly attempt: Omit<
    StreamAttemptHost<Context, State, State>,
    "persistCheckpoint"
  >;
  readonly persistence: OuterStreamPersistence<Context, State>;
  readonly cleanup?: () => void | Promise<void>;
  readonly onCompleted?: (streamState: State) => void | Promise<void>;
}

/**
 * Composes the immutable outer persistence boundary around createStreamAttempt.
 * Accepted checkpoint capture remains inside createStreamAttempt; this owner
 * only performs generation-gated settle persistence and host lifecycle hooks.
 * It is intentionally unconnected to SlateAgentRunner activation.
 */
export function createOuterStreamLifecycle<Context, State>(
  input: OuterStreamLifecycleInput<Context, State>,
) {
  const { persistence } = input;
  const attempt = createStreamAttempt<Context, State, State>({
    ...input.attempt,
    persistCheckpoint: async (context, checkpoint, accepted) => {
      if (persistence.runGeneration() !== persistence.generation) return;

      persistence.prepareCheckpointForPersistence(checkpoint);
      await persistence.persistStepCheckpoint(context, checkpoint);
      accepted(checkpoint);
      persistence.noteCheckpoint?.(checkpoint);
      persistence.commitDiskPressureReminder();
      persistence.noteAutomationStatusReminder?.();

      if (persistence.isAwaitingUserSelection()) {
        persistence.cancelRun({
          intentional: true,
          reason: "awaiting user selection",
        });
      } else if (persistence.isQuiescingForUpgrade()) {
        persistence.markQuiescedForUpgrade();
        persistence.cancelRun({
          intentional: true,
          reason: "quiescing for forced host upgrade",
        });
      }
    },
  });

  async function persistFinalState(
    context: Context,
    finalState: State,
  ): Promise<void> {
    if (persistence.runGeneration() !== persistence.generation) return;
    await persistence.persistFinalState(context, finalState);
    persistence.commitDiskPressureReminder();
  }

  return {
    async run(context: Context): Promise<State> {
      let finalState: State | undefined;
      try {
        finalState = await attempt.run();
        await input.onCompleted?.(finalState);
        return finalState;
      } finally {
        try {
          await input.cleanup?.();
        } finally {
          try {
            if (finalState !== undefined) {
              await persistFinalState(context, finalState);
            }
          } finally {
            persistence.releaseDiskPressureReminder();
          }
        }
      }
    },
    persistFinalState,
  };
}
