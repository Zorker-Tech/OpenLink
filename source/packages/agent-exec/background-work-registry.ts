/**
 * What background work a session is running, and what it owes the conversation when that work finishes.
 *
 * Two things are kept here, and they are kept together because they are two views of the same work. One is
 * the work itself: what is running, what it belongs to, and how to stop it. The other is the queue of
 * wakeups — completions waiting to be handed to a conversation — because a completion that is pulled but
 * not yet acknowledged must not be pulled again, and one that is acknowledged must not come back.
 *
 * The queue is careful about identity, because a wakeup that is delivered twice wakes a conversation twice.
 * A wakeup is accepted once per conversation and id; pulling moves it in flight; acknowledging forgets it;
 * negative-acknowledging either forgets it or puts it back, merged with whatever else is waiting for that
 * conversation. Suppression is the third state: work the session has decided not to be told about — it was
 * observed directly, or the user backgrounded it — is dropped on arrival, dropped if it is already waiting,
 * and dropped if it is in flight, while the suppression itself is remembered so a later arrival is dropped
 * too. Clearing a conversation forgets everything belonging to it.
 *
 * The registry on top exposes that queue in the shape the rest of the platform asks for: a completion is
 * enqueued under the legacy local conversation, drained as payloads, and marked awaited by suppressing it.
 * A revision counter increments whenever the queue changes, which is how a caller that polls can tell
 * whether anything happened without reading the queue itself.
 */

import { mergeWakeup, type Wakeup } from "./wakeup/index.ts"

interface BackgroundWorkRecord {
  id: string
  kind: string
  state: string
  ownerId?: string | undefined
  abort?: (() => void) | undefined
  metadata?: unknown
}

interface BackgroundWorkFilter {
  kind?: string | undefined
  state?: string | undefined
  ownerId?: string | undefined
}

interface BackgroundWorkSnapshot {
  id: string
  kind: string
  state: string
  ownerId?: string | undefined
  hasAbort: boolean
  metadata?: unknown
}

interface BackgroundCompletion {
  taskId: string
  kind: string
  [key: string]: unknown
}

interface LocalWakeup extends Wakeup {
  payload: unknown
  source?: string | undefined
}

/** A filter names what to select; leaving a field out means every value of it. */
function matchesFilter(record: BackgroundWorkRecord, filter: BackgroundWorkFilter | undefined): boolean {
  if (!filter) {
    return true
  }
  if (filter.kind && record.kind !== filter.kind) {
    return false
  }
  if (filter.state && record.state !== filter.state) {
    return false
  }
  if (filter.ownerId && record.ownerId !== filter.ownerId) {
    return false
  }
  return true
}

class InMemoryLocalWakeupQueue {
  private pending: LocalWakeup[] = []
  private readonly inFlightById = new Map<string, LocalWakeup>()
  private readonly acceptedKeys = new Set<string>()
  private readonly suppressedIdsByConversation = new Map<string, Set<string>>()
  private revision = 0

  private acceptedKey(conversationId: string, id: string): string {
    return `${conversationId}\0${id}`
  }

  enqueue(wakeup: LocalWakeup): void {
    const id = wakeup.id.trim()
    const key = this.acceptedKey(wakeup.conversationId, id)
    // A wakeup with no id, one already accepted, or one the conversation has suppressed is not queued.
    if (id.length === 0 || this.acceptedKeys.has(key)) {
      return
    }
    if (this.suppressedIdsByConversation.get(wakeup.conversationId)?.has(id)) {
      return
    }
    this.acceptedKeys.add(key)
    const { queue, replaced } = mergeWakeup(this.pending, { ...wakeup, id })
    this.pending = queue
    // What was replaced is no longer waiting, so its own claim on the id is released with it.
    if (replaced) {
      this.acceptedKeys.delete(this.acceptedKey(replaced.conversationId, replaced.id))
    }
    this.revision++
  }

  pull(conversationId: string): LocalWakeup[] {
    const suppressed = this.suppressedIdsByConversation.get(conversationId)
    const pulled: LocalWakeup[] = []
    const rest: LocalWakeup[] = []
    let dropped = 0
    for (const wakeup of this.pending) {
      if (wakeup.conversationId !== conversationId) {
        rest.push(wakeup)
        continue
      }
      // A suppressed wakeup is dropped where it waits rather than handed over.
      if (suppressed?.has(wakeup.id)) {
        this.acceptedKeys.delete(this.acceptedKey(conversationId, wakeup.id))
        dropped++
        continue
      }
      pulled.push(wakeup)
      this.inFlightById.set(wakeup.id, wakeup)
    }
    if (pulled.length > 0 || dropped > 0) {
      this.pending = rest
      this.revision++
    }
    return pulled.map((wakeup) => ({ ...wakeup }))
  }

  /** Every conversation's waiting wakeups, which is how the completion drain works. */
  pullAll(): LocalWakeup[] {
    const conversationIds = [
      ...new Set(this.pending.map((wakeup) => wakeup.conversationId)),
    ]
    return conversationIds.flatMap((conversationId) => this.pull(conversationId))
  }

  ack(ids: readonly string[]): LocalWakeup[] {
    const acked: LocalWakeup[] = []
    for (const id of ids) {
      const normalizedId = id.trim()
      const wakeup = this.inFlightById.get(normalizedId)
      if (wakeup) {
        this.acceptedKeys.delete(this.acceptedKey(wakeup.conversationId, normalizedId))
        acked.push(wakeup)
      }
      this.inFlightById.delete(normalizedId)
    }
    return acked
  }

  /** A requeued wakeup goes back where it came from, and an id that is not in flight is left alone. */
  nack(ids: readonly string[], opts: { requeue: boolean }): void {
    const requestedIds = new Set(ids.map((id) => id.trim()))
    const selected: LocalWakeup[] = []
    for (const [id, wakeup] of this.inFlightById) {
      if (!requestedIds.has(id)) {
        continue
      }
      selected.push(wakeup)
      this.inFlightById.delete(id)
    }
    if (!opts.requeue) {
      for (const wakeup of selected) {
        this.acceptedKeys.delete(this.acceptedKey(wakeup.conversationId, wakeup.id))
      }
      return
    }
    if (selected.length === 0) {
      return
    }
    let requeued = selected
    for (const pendingWakeup of this.pending) {
      const { queue, replaced } = mergeWakeup(requeued, pendingWakeup)
      requeued = queue
      if (replaced) {
        this.acceptedKeys.delete(this.acceptedKey(replaced.conversationId, replaced.id))
      }
    }
    this.pending = requeued
    this.revision++
  }

  suppress(conversationId: string, id: string): void {
    const normalizedId = id.trim()
    if (normalizedId.length === 0) {
      return
    }
    const suppressed = this.suppressedIdsByConversation.get(conversationId) ?? new Set<string>()
    suppressed.add(normalizedId)
    this.suppressedIdsByConversation.set(conversationId, suppressed)
    let changed = false
    const previousLength = this.pending.length
    this.pending = this.pending.filter(
      (wakeup) => wakeup.conversationId !== conversationId || wakeup.id !== normalizedId,
    )
    if (this.pending.length !== previousLength) {
      this.acceptedKeys.delete(this.acceptedKey(conversationId, normalizedId))
      changed = true
    }
    // A suppressed wakeup that is already in flight is dropped from there too, since the caller that holds
    // it will not be told about it.
    const inFlight = this.inFlightById.get(normalizedId)
    if (inFlight && inFlight.conversationId === conversationId) {
      this.inFlightById.delete(normalizedId)
      this.acceptedKeys.delete(this.acceptedKey(conversationId, normalizedId))
      changed = true
    }
    if (changed) {
      this.revision++
    }
  }

  unsuppress(conversationId: string, id: string): void {
    const suppressed = this.suppressedIdsByConversation.get(conversationId)
    if (!suppressed?.delete(id.trim())) {
      return
    }
    if (suppressed.size === 0) {
      this.suppressedIdsByConversation.delete(conversationId)
    }
  }

  /** Work that ended everywhere is unsuppressed everywhere, since its id is no longer meaningful. */
  unsuppressId(id: string): void {
    const normalizedId = id.trim()
    for (const conversationId of this.suppressedIdsByConversation.keys()) {
      this.unsuppress(conversationId, normalizedId)
    }
  }

  clear(conversationId: string): void {
    let changed = false
    const previousPendingLength = this.pending.length
    this.pending = this.pending.filter((wakeup) => wakeup.conversationId !== conversationId)
    if (this.pending.length !== previousPendingLength) {
      changed = true
    }
    for (const [id, wakeup] of this.inFlightById) {
      if (wakeup.conversationId === conversationId) {
        this.inFlightById.delete(id)
        changed = true
      }
    }
    // The accepted keys are prefixed by the conversation, so they are found without walking the queue.
    const keyPrefix = this.acceptedKey(conversationId, "")
    for (const key of this.acceptedKeys) {
      if (key.startsWith(keyPrefix)) {
        this.acceptedKeys.delete(key)
        changed = true
      }
    }
    const hadSuppressed = this.suppressedIdsByConversation.delete(conversationId)
    if (changed || hadSuppressed) {
      this.revision++
    }
  }

  hasPending(conversationId?: string): boolean {
    return conversationId === undefined
      ? this.pending.length > 0
      : this.pending.some((wakeup) => wakeup.conversationId === conversationId)
  }

  hasPendingMatching(conversationId: string, predicate: (payload: unknown) => boolean): boolean {
    return this.pending.some(
      (wakeup) => wakeup.conversationId === conversationId && predicate(wakeup.payload),
    )
  }

  getPendingCount(): number {
    return this.pending.length
  }

  getRevision(): number {
    return this.revision
  }
}

/** Completions that predate per-conversation wakeups all belong to this conversation. */
export const LEGACY_LOCAL_WAKEUP_CONVERSATION_ID = "local"

export class InMemoryBackgroundWorkRegistry {
  private readonly records = new Map<string, BackgroundWorkRecord>()
  private readonly wakeups = new InMemoryLocalWakeupQueue()

  upsertWork(record: BackgroundWorkRecord): void {
    this.records.set(record.id, record)
  }

  clearWork(id: string): boolean {
    const deleted = this.records.delete(id)
    // Work that is over is no longer suppressed: its id means nothing once it is gone.
    this.wakeups.unsuppressId(id)
    return deleted
  }

  abortWork(id: string): boolean {
    const record = this.records.get(id)
    if (!record) {
      return false
    }
    if (record.abort) {
      record.abort()
    }
    this.records.delete(id)
    this.wakeups.unsuppressId(id)
    return true
  }

  hasRunningWork(filter?: BackgroundWorkFilter): boolean {
    for (const record of this.records.values()) {
      if (record.state !== "running") {
        continue
      }
      if (matchesFilter(record, filter)) {
        return true
      }
    }
    return false
  }

  /** Every matching record is aborted, and the count is what was stopped. */
  abortAllWork(filter?: BackgroundWorkFilter): number {
    let aborted = 0
    for (const record of [...this.records.values()]) {
      if (!matchesFilter(record, filter)) {
        continue
      }
      if (record.abort) {
        record.abort()
      }
      aborted++
      this.records.delete(record.id)
      this.wakeups.unsuppressId(record.id)
    }
    return aborted
  }

  /** A snapshot says whether work can be stopped, without handing over the way to stop it. */
  listWork(filter?: BackgroundWorkFilter): BackgroundWorkSnapshot[] {
    const snapshots: BackgroundWorkSnapshot[] = []
    for (const record of this.records.values()) {
      if (!matchesFilter(record, filter)) {
        continue
      }
      snapshots.push({
        id: record.id,
        kind: record.kind,
        state: record.state,
        ownerId: record.ownerId,
        hasAbort: Boolean(record.abort),
        metadata: record.metadata,
      })
    }
    return snapshots
  }

  enqueue(wakeup: LocalWakeup): void {
    this.wakeups.enqueue(wakeup)
  }

  pull(conversationId: string): LocalWakeup[] {
    return this.wakeups.pull(conversationId)
  }

  ack(ids: readonly string[]): LocalWakeup[] {
    return this.wakeups.ack(ids)
  }

  nack(ids: readonly string[], opts: { requeue: boolean }): void {
    this.wakeups.nack(ids, opts)
  }

  suppress(conversationId: string, id: string): void {
    this.wakeups.suppress(conversationId, id)
  }

  enqueueCompletion(item: BackgroundCompletion): void {
    this.enqueue({
      conversationId: LEGACY_LOCAL_WAKEUP_CONVERSATION_ID,
      id: item.taskId,
      payload: item,
      source: item.kind,
    })
  }

  /** Everything waiting, handed over as payloads: what is drained is acknowledged in the same breath. */
  drainCompletions(): unknown[] {
    const wakeups = this.wakeups.pullAll()
    this.ack(wakeups.map((wakeup) => wakeup.id))
    return wakeups.map((wakeup) => wakeup.payload)
  }

  hasPendingCompletions(conversationId?: string): boolean {
    return this.wakeups.hasPending(conversationId)
  }

  /** Marking a completion awaited is suppressing it: the model saw it directly, so it must not be woken. */
  markAwaitedCompletion(taskId: string): void {
    this.suppress(LEGACY_LOCAL_WAKEUP_CONVERSATION_ID, taskId)
  }

  getWakeupRevision(): number {
    return this.wakeups.getRevision()
  }
}
