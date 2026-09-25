/**
 * Promise-shaped concurrency.
 *
 * Work that is cheap to describe but expensive to run — a page of model calls, a batch of file
 * reads — is started with a bound and awaited as a group. The bound is what keeps a burst of work
 * from exhausting sockets or file descriptors, and results keep their input order regardless of which
 * task finished first.
 */

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimeoutError"
  }
}

export function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, message?: string): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(message ?? `Promise timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Runs the selector over every item with at most `max` in flight; the result keeps input order. */
export async function asyncMapValues<Input, Output>(
  array: readonly Input[],
  selector: (value: Input) => Promise<Output> | Output,
  options?: { max?: number },
): Promise<Output[]> {
  const max = Math.max(1, options?.max ?? 4)
  const results = new Array<Output>(array.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= array.length) return
      results[index] = await selector(array[index] as Input)
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, array.length) }, worker))
  return results
}

/**
 * A queue that runs enqueued work with a bound on concurrency.
 *
 * Each enqueue returns the promise for its own work, so a caller can await one item without waiting
 * for the batch; the queue as a whole can be drained with `close`, which is what a shutdown path
 * needs to know that nothing is still running.
 */
export class PromiseQueue {
  private readonly pending = new Set<Promise<unknown>>()
  private readonly max: number
  private running = 0
  private readonly waiting: Array<() => void> = []
  private closed = false

  constructor(options?: { max?: number }) {
    this.max = Math.max(1, options?.max ?? 4)
  }

  private async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running += 1
      return
    }
    await new Promise<void>(resolve => this.waiting.push(resolve))
    this.running += 1
  }

  private release(): void {
    this.running -= 1
    const next = this.waiting.shift()
    if (next !== undefined) next()
  }

  enqueue<Value>(block: () => Promise<Value> | Value): Promise<Value> {
    if (this.closed) return Promise.reject(new Error("PromiseQueue is closed"))
    const operation = (async () => {
      await this.acquire()
      try {
        return await block()
      } finally {
        this.release()
      }
    })()
    this.pending.add(operation)
    void operation.catch(() => {}).finally(() => this.pending.delete(operation))
    return operation
  }

  async enqueueList<Key, Value>(
    list: readonly Key[],
    block: (item: Key) => Promise<Value> | Value,
  ): Promise<Map<Key, Value>> {
    const results = await asyncMapValues(list, item => this.enqueue(() => block(item)), { max: this.max })
    return new Map(list.map((item, index) => [item, results[index] as Value]))
  }

  /** Stops accepting work and resolves once everything already enqueued has settled. */
  async close(): Promise<void> {
    this.closed = true
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }
}
