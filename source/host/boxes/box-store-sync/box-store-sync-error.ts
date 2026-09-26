/**
 * The failure of syncing an agent store with a box.
 *
 * Syncing is done over a store the box owns, so a failure here is about the connection or the store rather
 * than about the agent's own files. The cause is kept, since the caller's next step depends on whether the
 * box was unreachable or the store refused the write.
 */

export class BoxStoreSyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BoxStoreSyncError"
  }
}
