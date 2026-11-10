const activeWrites = new Map<string, Promise<void>>();

export async function inPathOrder<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeWrites.get(path) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  activeWrites.set(path, tail);
  void tail.then(() => {
    if (activeWrites.get(path) === tail) activeWrites.delete(path);
  });
  return result;
}
