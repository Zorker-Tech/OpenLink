/** Run one task per worker, stopping new assignments after the first rejection. */
export async function forEachBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let hasFailed = false;

  async function worker(): Promise<void> {
    while (cursor < items.length && !hasFailed) {
      const item = items[cursor++];
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (error) {
        hasFailed = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

/** Prepare item waves ahead of bounded workers, and stop both sides on the first failure. */
export async function forEachWavePipelined<T, Work>(
  items: readonly T[],
  options: {
    readonly waveSize: number;
    readonly concurrency: number;
    readonly prepareWave: (wave: readonly T[]) => Promise<readonly Work[]>;
    readonly process: (work: Work) => Promise<void>;
  },
): Promise<void> {
  const waveSize = Math.max(1, options.waveSize);
  const readyQueue: Work[] = [];
  let nextIndex = 0;
  let wavePreparation: Promise<void> | undefined;
  let failure: unknown;
  let hasFailed = false;
  let waitingWorkers: Array<() => void> = [];

  const wakeWorkers = (): void => {
    const waiting = waitingWorkers;
    waitingWorkers = [];
    for (const wake of waiting) wake();
  };

  const beginWave = (): void => {
    if (hasFailed || wavePreparation != null || nextIndex >= items.length || readyQueue.length >= waveSize) return;
    const wave = items.slice(nextIndex, nextIndex + waveSize);
    nextIndex += waveSize;
    wavePreparation = options.prepareWave(wave)
      .then((work) => { readyQueue.push(...work); })
      .catch((error) => {
        hasFailed = true;
        failure ??= error;
      })
      .finally(() => {
        wavePreparation = undefined;
        beginWave();
        wakeWorkers();
      });
  };

  async function worker(): Promise<void> {
    for (;;) {
      if (hasFailed) return;
      const work = readyQueue.shift();
      if (work !== undefined) {
        beginWave();
        try {
          await options.process(work);
        } catch (error) {
          hasFailed = true;
          failure ??= error;
          wakeWorkers();
          return;
        }
        continue;
      }

      if (wavePreparation == null && nextIndex >= items.length) return;
      beginWave();
      const waitingForWork = readyQueue.length === 0 && !(wavePreparation == null && nextIndex >= items.length);
      if (waitingForWork) await new Promise<void>((resolve) => waitingWorkers.push(resolve));
    }
  }

  beginWave();
  const workerCount = Math.max(1, options.concurrency);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (hasFailed) throw failure;
}
