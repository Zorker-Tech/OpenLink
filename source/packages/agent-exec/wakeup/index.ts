/**
 * The wakeups a conversation is owed.
 *
 * Background work that finishes has to wake the conversation that started it, and a wakeup is that notification:
 * which conversation it belongs to, which piece of work it is about, and what to hand over when it is delivered.
 * Two wakeups for the same work in the same conversation are the same wakeup, so a queue holds at most one of them;
 * work that reports under a group key replaces the pending wakeup for its group instead, and the queue hands back
 * what it replaced so the caller can stop tracking it.
 *
 * The merge returns a new queue rather than changing the one it was given, since a caller may be holding on to the
 * queue it is about to replace.
 */

/** A wakeup owed to a conversation: the work it is about, and what to hand over when it is delivered. */
export interface Wakeup {
  conversationId: string;
  id: string;
  groupKey?: string;
  [key: string]: unknown;
}

/** Whether the pending queue already holds this wakeup: the same work in the same conversation. */
function alreadyQueued(pending: readonly Wakeup[], arriving: Wakeup): boolean {
  return pending.some((queued) => queued.conversationId === arriving.conversationId && queued.id === arriving.id);
}

/** The index of the wakeup waiting for this conversation's group, or -1 when nobody waits for it. */
function groupedIndexFor(pending: readonly Wakeup[], arriving: Wakeup): number {
  return pending.findIndex((queued) => queued.conversationId === arriving.conversationId && queued.groupKey === arriving.groupKey);
}

/** The queue with one wakeup merged into it, and the wakeup it replaced when it replaced one. */
export function mergeWakeup<T extends Wakeup>(pending: readonly T[], arriving: T): { queue: T[]; replaced?: T } {
  if (alreadyQueued(pending, arriving)) return { queue: [...pending] };
  const ownCopy = { ...arriving };
  // A wakeup with no group can only be appended; one with a group replaces the waiter for that group, if there is one.
  const waitingIndex = arriving.groupKey === undefined ? -1 : groupedIndexFor(pending, arriving);
  if (waitingIndex === -1) return { queue: [...pending, ownCopy] };
  const queue = [...pending];
  const displaced = queue[waitingIndex];
  queue[waitingIndex] = ownCopy;
  return displaced === undefined ? { queue } : { queue, replaced: displaced };
}
