/** Wake all waiters when an apply attempt changes state. */
export function notifySecretGenerationWaiters(waiters: Array<() => void>): void {
  const pending = waiters.splice(0, waiters.length);
  for (const wake of pending) wake();
}

/** Wait until a requested generation is applied, the service stops, or the caller's deadline expires. */
export async function waitForSecretGeneration(args: {
  readonly generation: number;
  readonly appliedGeneration: () => number;
  readonly isStopped: () => boolean;
  readonly waiters: Array<() => void>;
  readonly signal: AbortSignal;
}): Promise<void> {
  while (args.appliedGeneration() < args.generation && !args.isStopped()) {
    if (args.signal.aborted) throw args.signal.reason;
    await new Promise<void>((resolve, reject) => {
      const remove = (): void => {
        const position = args.waiters.indexOf(finish);
        if (position >= 0) args.waiters.splice(position, 1);
        args.signal.removeEventListener("abort", abort);
      };
      const finish = (): void => { remove(); resolve(); };
      const abort = (): void => { remove(); reject(args.signal.reason); };
      args.waiters.push(finish);
      args.signal.addEventListener("abort", abort, { once: true });
    });
  }
}
