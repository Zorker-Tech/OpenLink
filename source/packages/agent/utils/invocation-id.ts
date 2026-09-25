/**
 * Naming one invocation of an agent.
 *
 * A request id identifies a request, but the same request can be run more than once (a retry, a
 * follow-up, a resumed stream), and those runs must be distinguishable in transcripts and telemetry —
 * so each invocation gets its own id: the request id, how many invocations it has had, and a short
 * random suffix that keeps two processes from colliding. The counter is bounded, because an agent
 * that lives for days should not accumulate one entry per request forever.
 */

import { LRUCache } from "lru-cache"

import { createKey, type Context } from "../../context/context.ts"

const MAX_TRACKED_REQUESTS = 100_000
const SUFFIX_LENGTH = 4
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

const invocationCounts = new LRUCache<string, number>({ max: MAX_TRACKED_REQUESTS })

function generateSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => SUFFIX_ALPHABET.charAt(byte % SUFFIX_ALPHABET.length)).join("")
}

function nextInvocationCount(requestId: string): number {
  const current = invocationCounts.get(requestId) ?? 0
  invocationCounts.set(requestId, current + 1)
  return current
}

export function getInvocationIdFromRequestId(requestId: string): string {
  return `${requestId}-${nextInvocationCount(requestId)}-${generateSuffix()}`
}

/** Tests and replay tools install their own generator so an id is predictable. */
export const invocationIdGeneratorKey = createKey<() => string>(Symbol("invocationIdGenerator"), () => crypto.randomUUID())

export function getInvocationId(ctx: Context): string {
  return ctx.get(invocationIdGeneratorKey)()
}
