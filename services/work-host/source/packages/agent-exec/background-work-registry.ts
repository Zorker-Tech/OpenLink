/**
 * What background work a session is running, and what it owes the conversation when that work finishes.
 *
 * Two views of the same work live here. One is the work itself: what is running, what it belongs to and how to stop
 * it. The other is the queue of wakeups — completions waiting to be handed to a conversation — because a completion
 * that was pulled but not yet acknowledged must not be pulled again, and one that was acknowledged must not come back.
 *
 * The queue is careful about identity, because a wakeup delivered twice wakes a conversation twice. A wakeup is
 * accepted once per conversation and id; pulling moves it in flight; acknowledging forgets it; a refusal either
 * forgets it or puts it back, merged with whatever else waits for that conversation. Suppression is the third state:
 * work a conversation has decided not to be told about — it was observed directly, or the user backgrounded it — is
 * dropped on arrival, dropped while it waits and dropped from flight, and the suppression itself is remembered so a
 * later arrival is dropped too. Clearing a conversation forgets everything belonging to it.
 *
 * The registry on top exposes the queue in the shape the rest of the platform asks for: a completion is enqueued under
 * the legacy local conversation, drained as payloads, and marked awaited by suppressing it. A revision counter moves
 * whenever the queue changes, so a polling caller can tell whether anything happened without reading the queue.
 */

import { mergeWakeup, type Wakeup } from "./wakeup/index.ts"

/** One piece of background work: what it is, what it belongs to, and how to stop it. */
interface WorkRecord {
  kind: string
  id: string
  state: string
  ownerId?: string | undefined
  abort?: (() => void) | undefined
  metadata?: unknown
}

/** What a caller wants to select: a field left out means every value of it. */
interface WorkSelection {
  kind?: string | undefined
  ownerId?: string | undefined
  state?: string | undefined
}

/** What a caller is told about one piece of work: enough to decide, without the way to stop it. */
interface WorkListing {
  id: string
  kind: string
  state: string
  ownerId?: string | undefined
  metadata?: unknown
  hasAbort: boolean
}

/** One completion, answered to the conversation that ran the work. */
interface CompletionItem {
  taskId: string
  kind: string
  [key: string]: unknown
}

/** A wakeup as the queue keeps it: the wakeup identity plus what the conversation is woken with. */
interface QueuedWakeup extends Wakeup {
  payload: unknown
  source?: string | undefined
}

/** Whether a record is what the caller selected; an empty selection matches every record. */
function workMatches(record: WorkRecord, selection: WorkSelection | undefined): boolean {
  if (selection === undefined) return true
  if (selection.kind && record.kind !== selection.kind) return false
  if (selection.state && record.state !== selection.state) return false
  if (selection.ownerId && record.ownerId !== selection.ownerId) return false
  return true
}

/** The wakeup queue: what waits, what is in flight, what was already accepted and what a conversation suppressed. */
class LocalWakeupQueue {
  private waiting: QueuedWakeup[] = []
  private readonly inFlight = new Map<string, QueuedWakeup>()
  private readonly claimed = new Set<string>()
  private readonly suppressed = new Map<string, Set<string>>()
  private changes = 0

  /** The key a conversation-and-id pair is claimed under, distinct even when ids contain separators. */
  private keyFor(conversationId: string, id: string): string {
    return `${conversationId}\0${id}`
  }

  /** Whether this wakeup may be queued: it needs an id, an unclaimed id and no suppression on the conversation. */
  private accepts(conversationId: string, id: string): boolean {
    if (id.length === 0 || this.claimed.has(this.keyFor(conversationId, id))) return false
    return this.suppressed.get(conversationId)?.has(id) !== true
  }

  /** Put a wakeup into waiting, releasing the claim of whatever it replaced. */
  private put(wakeup: QueuedWakeup): void {
    const { queue, replaced } = mergeWakeup(this.waiting, wakeup)
    this.waiting = queue
    if (replaced) this.claimed.delete(this.keyFor(replaced.conversationId, replaced.id))
  }

  enqueue(wakeup: QueuedWakeup): void {
    const id = wakeup.id.trim()
    if (!this.accepts(wakeup.conversationId, id)) return
    this.claimed.add(this.keyFor(wakeup.conversationId, id))
    this.put({ ...wakeup, id })
    this.changes++
  }

  /** Hand over this conversation's waiting wakeups, dropping the suppressed ones on the way. */
  pull(conversationId: string): QueuedWakeup[] {
    const suppressedHere = this.suppressed.get(conversationId)
    const taken: QueuedWakeup[] = []
    const remaining: QueuedWakeup[] = []
    for (const wakeup of this.waiting) {
      if (wakeup.conversationId !== conversationId) {
        remaining.push(wakeup)
        continue
      }
      if (suppressedHere?.has(wakeup.id)) {
        this.claimed.delete(this.keyFor(conversationId, wakeup.id))
        continue
      }
      taken.push(wakeup)
      this.inFlight.set(wakeup.id, wakeup)
    }
    const waitingChanged = taken.length > 0 || remaining.length !== this.waiting.length
    if (waitingChanged) {
      this.waiting = remaining
      this.changes++
    }
    return taken.map(wakeup => ({ ...wakeup }))
  }

  /** Every conversation's waiting wakeups, in the order the conversations first appear. */
  pullAll(): QueuedWakeup[] {
    const conversationIds = [...new Set(this.waiting.map(wakeup => wakeup.conversationId))]
    const taken: QueuedWakeup[] = []
    for (const conversationId of conversationIds) taken.push(...this.pull(conversationId))
    return taken
  }

  /** Acknowledge the ids that are in flight, answering the wakeups that were actually there. */
  ack(ids: readonly string[]): QueuedWakeup[] {
    const acknowledged: QueuedWakeup[] = []
    for (const rawId of ids) {
      const id = rawId.trim()
      const wakeup = this.inFlight.get(id)
      if (wakeup) {
        this.claimed.delete(this.keyFor(wakeup.conversationId, id))
        acknowledged.push(wakeup)
      }
      this.inFlight.delete(id)
    }
    return acknowledged
  }

  /** Refuse ids in flight: forget them outright, or put them back merged with what is still waiting. */
  nack(ids: readonly string[], opts: { requeue: boolean }): void {
    const wanted = new Set(ids.map(id => id.trim()))
    const refused: QueuedWakeup[] = []
    for (const [id, wakeup] of this.inFlight) {
      if (!wanted.has(id)) continue
      refused.push(wakeup)
      this.inFlight.delete(id)
    }
    if (!opts.requeue) {
      for (const wakeup of refused) this.claimed.delete(this.keyFor(wakeup.conversationId, wakeup.id))
      return
    }
    if (refused.length === 0) return
    let requeued = refused
    for (const waiting of this.waiting) {
      const { queue, replaced } = mergeWakeup(requeued, waiting)
      requeued = queue
      if (replaced) this.claimed.delete(this.keyFor(replaced.conversationId, replaced.id))
    }
    this.waiting = requeued
    this.changes++
  }

  /** Remember a suppression, and drop the wakeup it names from waiting and from flight. */
  suppress(conversationId: string, id: string): void {
    const normalizedId = id.trim()
    if (normalizedId.length === 0) return
    const suppressedHere = this.suppressed.get(conversationId) ?? new Set<string>()
    suppressedHere.add(normalizedId)
    this.suppressed.set(conversationId, suppressedHere)
    let changed = false
    const beforeFiltering = this.waiting.length
    this.waiting = this.waiting.filter(wakeup => wakeup.conversationId !== conversationId || wakeup.id !== normalizedId)
    if (this.waiting.length !== beforeFiltering) {
      this.claimed.delete(this.keyFor(conversationId, normalizedId))
      changed = true
    }
    const inFlight = this.inFlight.get(normalizedId)
    if (inFlight && inFlight.conversationId === conversationId) {
      this.inFlight.delete(normalizedId)
      this.claimed.delete(this.keyFor(conversationId, normalizedId))
      changed = true
    }
    if (changed) this.changes++
  }

  unsuppress(conversationId: string, id: string): void {
    const suppressedHere = this.suppressed.get(conversationId)
    if (!suppressedHere?.delete(id.trim())) return
    if (suppressedHere.size === 0) this.suppressed.delete(conversationId)
  }

  /** Work that ended everywhere is unsuppressed everywhere: its id no longer means anything. */
  unsuppressId(id: string): void {
    const normalizedId = id.trim()
    for (const conversationId of this.suppressed.keys()) this.unsuppress(conversationId, normalizedId)
  }

  /** Forget everything a conversation was waiting for, was holding, had claimed or had suppressed. */
  clear(conversationId: string): void {
    let changed = false
    const beforeFiltering = this.waiting.length
    this.waiting = this.waiting.filter(wakeup => wakeup.conversationId !== conversationId)
    if (this.waiting.length !== beforeFiltering) changed = true
    for (const [id, wakeup] of this.inFlight) {
      if (wakeup.conversationId === conversationId) {
        this.inFlight.delete(id)
        changed = true
      }
    }
    const keyPrefix = this.keyFor(conversationId, "")
    for (const key of this.claimed) {
      if (key.startsWith(keyPrefix)) {
        this.claimed.delete(key)
        changed = true
      }
    }
    const hadSuppression = this.suppressed.delete(conversationId)
    if (changed || hadSuppression) this.changes++
  }

  hasPending(conversationId?: string): boolean {
    if (conversationId === undefined) return this.waiting.length > 0
    return this.waiting.some(wakeup => wakeup.conversationId === conversationId)
  }

  hasPendingMatching(conversationId: string, predicate: (payload: unknown) => boolean): boolean {
    return this.waiting.some(wakeup => wakeup.conversationId === conversationId && predicate(wakeup.payload))
  }

  getPendingCount(): number {
    return this.waiting.length
  }

  getRevision(): number {
    return this.changes
  }
}

/** Completions that predate per-conversation wakeups all belong to this conversation. */
export const LEGACY_LOCAL_WAKEUP_CONVERSATION_ID = "local"

/** What background work a session is running: the work, and the wakeups it owes the conversation. */
export class InMemoryBackgroundWorkRegistry {
  private readonly work = new Map<string, WorkRecord>()
  private readonly wakeups = new LocalWakeupQueue()

  upsertWork(record: WorkRecord): void {
    this.work.set(record.id, record)
  }

  clearWork(id: string): boolean {
    const deleted = this.work.delete(id)
    this.wakeups.unsuppressId(id)
    return deleted
  }

  abortWork(id: string): boolean {
    const record = this.work.get(id)
    if (!record) return false
    if (record.abort) record.abort()
    this.work.delete(id)
    this.wakeups.unsuppressId(id)
    return true
  }

  hasRunningWork(selection?: WorkSelection): boolean {
    for (const record of this.work.values()) {
      if (record.state !== "running") continue
      if (workMatches(record, selection)) return true
    }
    return false
  }

  /** Every matching record is stopped, and the answer is how many were. */
  abortAllWork(selection?: WorkSelection): number {
    let stopped = 0
    for (const record of [...this.work.values()]) {
      if (!workMatches(record, selection)) continue
      if (record.abort) record.abort()
      stopped++
      this.work.delete(record.id)
      this.wakeups.unsuppressId(record.id)
    }
    return stopped
  }

  /** What a caller is told about one record: enough to decide, without the way to stop it. */
  listWork(selection?: WorkSelection): WorkListing[] {
    const listings: WorkListing[] = []
    for (const record of this.work.values()) {
      if (!workMatches(record, selection)) continue
      listings.push({
        id: record.id,
        kind: record.kind,
        state: record.state,
        ownerId: record.ownerId,
        hasAbort: Boolean(record.abort),
        metadata: record.metadata,
      })
    }
    return listings
  }

  enqueue(wakeup: QueuedWakeup): void {
    this.wakeups.enqueue(wakeup)
  }

  pull(conversationId: string): QueuedWakeup[] {
    return this.wakeups.pull(conversationId)
  }

  ack(ids: readonly string[]): QueuedWakeup[] {
    return this.wakeups.ack(ids)
  }

  nack(ids: readonly string[], opts: { requeue: boolean }): void {
    this.wakeups.nack(ids, opts)
  }

  suppress(conversationId: string, id: string): void {
    this.wakeups.suppress(conversationId, id)
  }

  enqueueCompletion(item: CompletionItem): void {
    this.enqueue({
      conversationId: LEGACY_LOCAL_WAKEUP_CONVERSATION_ID,
      id: item.taskId,
      payload: item,
      source: item.kind,
    })
  }

  /** Hand over everything waiting as payloads; what is drained is acknowledged in the same breath. */
  drainCompletions(): unknown[] {
    const drained = this.wakeups.pullAll()
    this.ack(drained.map(wakeup => wakeup.id))
    return drained.map(wakeup => wakeup.payload)
  }

  hasPendingCompletions(conversationId?: string): boolean {
    return this.wakeups.hasPending(conversationId)
  }

  /** Marking a completion awaited is suppressing it: the model saw it, so it must not wake the conversation. */
  markAwaitedCompletion(taskId: string): void {
    this.suppress(LEGACY_LOCAL_WAKEUP_CONVERSATION_ID, taskId)
  }

  getWakeupRevision(): number {
    return this.wakeups.getRevision()
  }
}
