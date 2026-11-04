import type { Clock } from "../../host/extensions/scheduling.ts"

type SendIdentity = { readonly accountSlot: string; readonly clientNonce: string }
type PendingEcho = { readonly traceparent: string; readonly recordedAt: number }

function keyFor(identity: SendIdentity): string {
  return `${identity.accountSlot}\0${identity.clientNonce}`
}

/** Remember sampled sends until their matching user event arrives, with age and count limits. */
export function createSendEchoLedger(options: {
  readonly clock: Pick<Clock, "monotonicNow">
  readonly maximumEntries: number
  readonly lifetimeMs: number
  readonly onEcho: (identity: SendIdentity, traceparent: string) => void
}) {
  const pending = new Map<string, PendingEcho>()

  function pruneAt(now: number): void {
    for (const [key, item] of pending) {
      if (now - item.recordedAt > options.lifetimeMs) pending.delete(key)
    }
  }

  return {
    arm(identity: SendIdentity, traceparent: string): void {
      const now = options.clock.monotonicNow()
      pruneAt(now)

      if (pending.size >= options.maximumEntries) {
        const oldestKey = pending.keys().next().value
        if (oldestKey !== undefined) pending.delete(oldestKey)
      }
      pending.set(keyFor(identity), { traceparent, recordedAt: now })
    },
    consume(identity: SendIdentity): void {
      const recordKey = keyFor(identity)
      const item = pending.get(recordKey)
      if (item === undefined) return

      pending.delete(recordKey)
      options.onEcho(identity, item.traceparent)
    },
  }
}
