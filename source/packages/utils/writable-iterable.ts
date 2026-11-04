/**
 * A stream a producer writes into and a consumer reads from, in order.
 *
 * This is the seam between a callback-shaped producer (a child process, a socket, a model stream) and
 * a consumer that wants to `for await`. Writes are backpressured — `write` resolves once the reader
 * has caught up — and closing or failing the stream wakes whoever is waiting rather than leaving them
 * parked forever.
 */

export class WriteIterableClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WriteIterableClosedError"
  }
}

interface PendingReader<T> {
  resolve: (result: IteratorResult<T>) => void
  reject: (error: unknown) => void
}

export interface WritableIterable<T> extends AsyncIterable<T> {
  write(value: T): Promise<void>
  throw(error: unknown): void
  close(): void
}

export function createWritableIterable<T>(): WritableIterable<T> {
  const pendingReaders: PendingReader<T>[] = []
  const written = new Array<T>()
  let closed = false
  let failure: { readonly reason: unknown } | undefined
  let resolveBackpressure: () => void = () => {}
  let rejectBackpressure: (error: unknown) => void = () => {}

  const newBackpressure = (): Promise<void> => {
    const promise = new Promise<void>((resolve, reject) => {
      resolveBackpressure = resolve
      rejectBackpressure = reject
    })
    void promise.catch(() => {})
    return promise
  }
  let backpressure = newBackpressure()

  const releaseReaders = (result: IteratorResult<T>, error?: { readonly reason: unknown }): void => {
    while (pendingReaders.length > 0) {
      const reader = pendingReaders.shift()
      if (reader === undefined) continue
      if (error !== undefined) reader.reject(error.reason)
      else reader.resolve(result)
    }
  }

  const failBackpressure = (error: unknown): void => {
    written.length = 0
    rejectBackpressure(error)
    backpressure = Promise.reject(error)
    void backpressure.catch(() => {})
  }

  return {
    async write(value: T): Promise<void> {
      if (closed) {
        if (failure !== undefined) throw failure.reason
        throw new WriteIterableClosedError("WritableIterable is closed")
      }
      const reader = pendingReaders.shift()
      if (reader !== undefined) {
        reader.resolve({ done: false, value })
        if (pendingReaders.length > 0) return
      } else {
        written.push(value)
      }
      // Wait for the consumer to take what is buffered, so a producer cannot outrun its reader.
      const waits = written.length + 1
      for (let index = 0; index < waits; index++) await backpressure
    },
    throw(error: unknown): void {
      if (closed) return
      closed = true
      failure = { reason: error }
      failBackpressure(error)
      releaseReaders({ done: true, value: undefined }, failure)
    },
    close(): void {
      if (closed) return
      closed = true
      written.length = 0
      resolveBackpressure()
      backpressure = Promise.reject(new WriteIterableClosedError("WritableIterable is closed"))
      void backpressure.catch(() => {})
      releaseReaders({ done: true, value: undefined })
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          resolveBackpressure()
          backpressure = newBackpressure()
          const buffered = written.shift()
          if (buffered !== undefined) return Promise.resolve({ done: false, value: buffered })
          if (closed) {
            return failure === undefined
              ? Promise.resolve({ done: true, value: undefined })
              : Promise.reject(failure.reason)
          }
          return new Promise((resolve, reject) => pendingReaders.push({ resolve, reject }))
        },
        throw(error: unknown): Promise<IteratorResult<T>> {
          closed = true
          failure = { reason: error }
          written.length = 0
          failBackpressure(error)
          releaseReaders({ done: true, value: undefined }, failure)
          return Promise.resolve({ done: true, value: undefined })
        },
        return(): Promise<IteratorResult<T>> {
          closed = true
          written.length = 0
          resolveBackpressure()
          backpressure = Promise.reject(new Error("Iterator was closed"))
          void backpressure.catch(() => {})
          releaseReaders({ done: true, value: undefined })
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
