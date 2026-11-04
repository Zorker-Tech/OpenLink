export function enqueueRoomEntry(
  queues: Map<string, Promise<void>>,
  roomId: string,
  publish: () => Promise<void>,
): void {
  const previous = queues.get(roomId) ?? Promise.resolve();
  const next = previous.then(publish).catch(() => {});
  queues.set(roomId, next);
}
