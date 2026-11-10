/**
 * Peeking at an async iterable.
 *
 * A consumer sometimes has to see the first item before it can decide how to consume the rest — the first item names
 * the stream, decides the renderer, or tells the caller whether there is anything to render at all. The remainder is
 * handed back as an iterable that continues where the peek stopped.
 */

/** The items after the first one: an async generator that keeps reading the same iterator. */
async function* itemsAfter<Item>(iterator: AsyncIterator<Item>): AsyncGenerator<Item> {
  for (;;) {
    const following = await iterator.next();
    if (following.done === true) return;
    yield following.value;
  }
}

/** The first item of an async iterable and the rest of it, or undefined when the iterable is empty. */
export async function getFirstItem<Item>(source: AsyncIterable<Item>): Promise<{ firstItem: Item; rest: AsyncIterable<Item> } | undefined> {
  const iterator = source[Symbol.asyncIterator]();
  const peeked = await iterator.next();
  if (peeked.done === true) return undefined;
  const rest: AsyncIterable<Item> = { [Symbol.asyncIterator]: () => itemsAfter(iterator) };
  return { firstItem: peeked.value, rest };
}
