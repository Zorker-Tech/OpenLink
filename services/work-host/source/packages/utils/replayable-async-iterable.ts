/**
 * An async iterable that many consumers can read, each from the beginning.
 *
 * A stream of transcript updates is often needed by two readers at once — one that renders and one
 * that records — and neither can be told to wait for the other. The source is consumed once and
 * buffered; every consumer replays the buffer and then follows along, so a late consumer sees the
 * same sequence as an early one.
 */

export class ReplayableAsyncIterable<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private ended = false
  private sourceError: Error | undefined
  private readonly readers = new Set<() => void>()

  constructor(input: AsyncIterable<T> | Iterable<T>) {
    void this.readSource(input)
  }

  private async readSource(input: AsyncIterable<T> | Iterable<T>): Promise<void> {
    try {
      for await (const item of input) {
        this.values.push(item)
        this.notifyReaders()
      }
    } catch (cause) {
      this.sourceError = cause instanceof Error ? cause : new Error(String(cause))
    } finally {
      this.ended = true
      this.notifyReaders()
    }
  }

  private notifyReaders(): void {
    const pending = [...this.readers]
    this.readers.clear()
    for (const wake of pending) wake()
  }

  private waitForValue(): Promise<void> {
    return new Promise((resolve) => this.readers.add(resolve))
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor = 0
    while (true) {
      while (cursor < this.values.length) {
        yield this.values[cursor++] as T
      }
      if (this.ended) {
        if (this.sourceError !== undefined) throw this.sourceError
        return
      }
      await this.waitForValue()
    }
  }
}
