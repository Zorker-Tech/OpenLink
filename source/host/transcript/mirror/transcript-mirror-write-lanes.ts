const activeWrites = new Map<string, Promise<unknown>>();

export function serializeTranscriptWrite<T>(canonicalPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeWrites.get(canonicalPath) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  activeWrites.set(canonicalPath, next);
  void next.finally(() => {
    if (activeWrites.get(canonicalPath) === next) activeWrites.delete(canonicalPath);
  }).catch(() => {});
  return next;
}
