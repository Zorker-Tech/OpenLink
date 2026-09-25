/**
 * Peeking at an async iterable.
 *
 * A consumer sometimes has to see the first item before it can decide how to consume the rest — the
 * first item names the stream, decides the renderer, or tells the caller whether there is anything to
 * render at all. The remainder is handed back as an iterable that continues where the peek stopped.
 */

export async function getFirstItem<T>(
  iterable: AsyncIterable<T>,
): Promise<{ firstItem: T; rest: AsyncIterable<T> } | undefined> {
  const iterator = iterable[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) return undefined
  const rest: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    },
  }
  return { firstItem: first.value, rest }
}
