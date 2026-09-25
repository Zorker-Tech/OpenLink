/**
 * An async iterable that many consumers can read, each from the beginning.
 *
 * A stream of transcript updates is often needed by two readers at once — one that renders and one
 * that records — and neither can be told to wait for the other. The source is consumed once and
 * buffered; every consumer replays the buffer and then follows along, so a late consumer sees the
 * same sequence as an early one.
 */

export class ReplayableAsyncIterable<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private closed = false
  private failure: Error | undefined
  private waiters: Array<() => void> = []

  constructor(source: AsyncIterable<T> | Iterable<T>) {
    void this.consume(source)
  }

  private async consume(source: AsyncIterable<T> | Iterable<T>): Promise<void> {
    try {
      for await (const value of source) {
        this.buffer.push(value)
        this.wakeWaiters()
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
    } finally {
      this.closed = true
      this.wakeWaiters()
    }
  }

  private wakeWaiters(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0
    while (true) {
      while (index < this.buffer.length) yield this.buffer[index++] as T
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure
        return
      }
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
  }
}
