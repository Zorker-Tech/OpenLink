/**
 * The wakeups a conversation is owed.
 *
 * Background work that finishes has to wake the conversation that started it, and a wakeup is that
 * notification: which conversation it belongs to, which piece of work it is about, and what to hand over
 * when it is delivered. Two wakeups for the same work in the same conversation are the same wakeup, so a
 * queue holds at most one of them; work that reports under a group key replaces the pending wakeup for its
 * group instead, and the queue hands back what it replaced so the caller can stop tracking it.
 *
 * The merge returns a new queue rather than changing the one it was given, since a caller may be holding
 * the queue it is about to replace.
 */

export interface Wakeup { conversationId: string; id: string; groupKey?: string; [key: string]: unknown }

export function mergeWakeup<T extends Wakeup>(queue: readonly T[], incoming: T): { queue: T[]; replaced?: T } {
  if (queue.some((wakeup) => wakeup.conversationId === incoming.conversationId && wakeup.id === incoming.id)) {
    return { queue: [...queue] }
  }
  const ownedIncoming = { ...incoming }
  if (incoming.groupKey === undefined) return { queue: [...queue, ownedIncoming] }
  const groupedIndex = queue.findIndex((wakeup) => wakeup.conversationId === incoming.conversationId && wakeup.groupKey === incoming.groupKey)
  if (groupedIndex === -1) return { queue: [...queue, ownedIncoming] }
  const merged = [...queue]
  const replaced = merged[groupedIndex]
  merged[groupedIndex] = ownedIncoming
  return replaced === undefined ? { queue: merged } : { queue: merged, replaced }
}
