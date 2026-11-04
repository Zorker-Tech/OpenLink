/** A Slate-owned cache for store credentials and the decisions made when minting them fails. */

import { AgentStoreUnauthorizedError } from "./bcs-client.ts"
import { AgentStoreRetrySchedule } from "./backoff-scheduler.ts"
import { mintFailureIsCacheable, syncIsDisabledForAccount } from "./connect-errors.ts"
import type { AgentStoreMintTarget, AgentStoreToken } from "./agent-store-sync-contracts.ts"

const STAND_DOWN_UNTIL_CHANGED = Number.POSITIVE_INFINITY

export interface AgentStoreTokenCacheMetrics {
  tokenMinted(event: {
    readonly agentId: string
    readonly reason: "cold" | "near_expiry" | "after_unauthorized"
  }): void
  tokenRefreshUnauthorized(event: { readonly agentId: string; readonly op: string }): void
  tokenMintNegativeCached?(event: { readonly agentId: string; readonly untilMs: number }): void
  tokenMintFailureCached?(event: { readonly agentId: string; readonly kind: "stand_down" | "backoff" }): void
}

export interface AgentStoreTokenCacheOptions {
  readonly mintToken: (target: AgentStoreMintTarget) => Promise<AgentStoreToken>
  readonly metrics?: AgentStoreTokenCacheMetrics
  readonly now?: () => number
  readonly refreshBufferMs?: number
  readonly negativeCacheBaseMs?: number
  readonly negativeCacheMaxMs?: number
  readonly onSyncDisabledMint?: (event: { readonly agentId: string; readonly message: string }) => void | Promise<void>
}

interface CachedMintRefusal {
  readonly error: unknown
  readonly untilMs: number
  readonly retrySchedule: AgentStoreRetrySchedule
}

interface TokenSlot {
  token?: AgentStoreToken
  pendingMint?: Promise<AgentStoreToken>
  refusal?: CachedMintRefusal
}

interface TokenCall {
  readonly cacheKey: string
  readonly agentId: string
  readonly target: AgentStoreMintTarget
  readonly operationName: string
  readonly signal?: AbortSignal
}

const SILENT_METRICS: AgentStoreTokenCacheMetrics = {
  tokenMinted() {},
  tokenRefreshUnauthorized() {},
}

/** Serializes minting by cache key and retries one operation after an authentication refusal. */
export class AgentStoreTokenCache {
  private readonly slots = new Map<string, TokenSlot>()
  private readonly metrics: AgentStoreTokenCacheMetrics
  private readonly now: () => number
  private readonly refreshBufferMs: number
  private readonly negativeCacheBaseMs: number
  private readonly negativeCacheMaxMs: number
  private readonly onSyncDisabledMint: AgentStoreTokenCacheOptions["onSyncDisabledMint"]

  constructor(private readonly options: AgentStoreTokenCacheOptions) {
    this.metrics = options.metrics ?? SILENT_METRICS
    this.now = options.now ?? Date.now
    this.refreshBufferMs = options.refreshBufferMs ?? 60_000
    this.negativeCacheBaseMs = options.negativeCacheBaseMs ?? 30_000
    this.negativeCacheMaxMs = options.negativeCacheMaxMs ?? 15 * 60_000
    this.onSyncDisabledMint = options.onSyncDisabledMint
  }

  /** Use the current credential, renewing once when the store rejects it as unauthorized. */
  async run<T>(call: TokenCall, operation: (token: AgentStoreToken) => Promise<T>): Promise<T> {
    const firstToken = await this.acquire(call)
    try {
      return await operation(firstToken)
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      this.metrics.tokenRefreshUnauthorized({ agentId: call.agentId, op: call.operationName })
      this.invalidateIfCurrent(call.cacheKey, firstToken)
      const renewed = await this.acquire({ ...call, reason: "after_unauthorized" })
      return await operation(renewed)
    }
  }

  /** A cached token may still name the store needed to invalidate its listing. */
  getForInvalidation(cacheKey: string): AgentStoreToken | undefined {
    return this.slots.get(cacheKey)?.token
  }

  private async acquire(call: TokenCall & { readonly reason?: "after_unauthorized" }): Promise<AgentStoreToken> {
    let slot = this.slots.get(call.cacheKey)
    if (slot?.refusal !== undefined) {
      if (this.now() < slot.refusal.untilMs) {
        this.metrics.tokenMintNegativeCached?.({ agentId: call.agentId, untilMs: slot.refusal.untilMs })
        throw slot.refusal.error
      }
      delete slot.refusal
      this.removeIfEmpty(call.cacheKey, slot)
    }

    slot = this.slots.get(call.cacheKey)
    const cached = slot?.token
    if (cached !== undefined && cached.expiresAtMs - this.now() > this.refreshBufferMs) return cached
    if (slot?.pendingMint !== undefined) return await awaitWithAbortSignal(slot.pendingMint, call.signal)

    const reason = call.reason ?? (cached === undefined ? "cold" : "near_expiry")
    slot ??= {}
    this.slots.set(call.cacheKey, slot)
    let mintRequest: Promise<AgentStoreToken>
    try {
      mintRequest = this.options.mintToken(call.target)
    } catch (error) {
      mintRequest = Promise.reject(error)
    }
    const pendingMint = Promise.resolve(mintRequest)
    slot.pendingMint = pendingMint
    void pendingMint.then(
      token => this.keepMintedToken(call, slot!, pendingMint, token, reason),
      error => this.keepMintRefusal(call, slot!, pendingMint, error),
    )
    return await awaitWithAbortSignal(pendingMint, call.signal)
  }

  private keepMintedToken(
    call: TokenCall,
    slot: TokenSlot,
    pendingMint: Promise<AgentStoreToken>,
    token: AgentStoreToken,
    reason: "cold" | "near_expiry" | "after_unauthorized",
  ): void {
    if (slot.pendingMint !== pendingMint) return
    slot.token = token
    delete slot.pendingMint
    delete slot.refusal
    this.metrics.tokenMinted({ agentId: call.agentId, reason })
  }

  private keepMintRefusal(
    call: TokenCall,
    slot: TokenSlot,
    pendingMint: Promise<AgentStoreToken>,
    error: unknown,
  ): void {
    if (slot.pendingMint !== pendingMint) return
    delete slot.pendingMint
    this.rememberRefusal(call, slot, error)
    this.removeIfEmpty(call.cacheKey, slot)
  }

  private rememberRefusal(call: TokenCall, slot: TokenSlot, error: unknown): void {
    if (syncIsDisabledForAccount(error)) {
      const retrySchedule = slot.refusal?.retrySchedule ?? this.newRetrySchedule()
      slot.refusal = { error, untilMs: STAND_DOWN_UNTIL_CHANGED, retrySchedule }
      this.metrics.tokenMintFailureCached?.({ agentId: call.agentId, kind: "stand_down" })
      this.notifySyncDisabled({ agentId: call.agentId, message: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!mintFailureIsCacheable(error)) return
    const retrySchedule = slot.refusal?.retrySchedule ?? this.newRetrySchedule()
    slot.refusal = {
      error,
      untilMs: this.now() + retrySchedule.noteFailure(),
      retrySchedule,
    }
    this.metrics.tokenMintFailureCached?.({ agentId: call.agentId, kind: "backoff" })
  }

  private invalidateIfCurrent(cacheKey: string, rejected: AgentStoreToken): void {
    const slot = this.slots.get(cacheKey)
    if (slot?.token !== rejected) return
    delete slot.token
    this.removeIfEmpty(cacheKey, slot)
  }

  private removeIfEmpty(cacheKey: string, slot: TokenSlot): void {
    if (slot.token === undefined && slot.pendingMint === undefined && slot.refusal === undefined) {
      this.slots.delete(cacheKey)
    }
  }

  private newRetrySchedule(): AgentStoreRetrySchedule {
    return new AgentStoreRetrySchedule({
      initialDelayMs: this.negativeCacheBaseMs,
      maximumDelayMs: this.negativeCacheMaxMs,
      jitterFraction: 0.2,
    })
  }

  /** Notifications never own the mint result or its stand-down state. */
  private notifySyncDisabled(event: { readonly agentId: string; readonly message: string }): void {
    if (this.onSyncDisabledMint === undefined) return
    try {
      const notification = this.onSyncDisabledMint(event)
      if (notification !== undefined && notification !== null && typeof (notification as Promise<void>).then === "function") {
        void (notification as Promise<void>).then(() => undefined, () => undefined)
      }
    } catch {}
  }
}

function newAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")
}

/** A caller can stop waiting on a shared mint without canceling the mint for its other callers. */
function awaitWithAbortSignal<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending
  if (signal.aborted) return Promise.reject(newAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(newAbortError(signal))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    pending.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof AgentStoreUnauthorizedError) return true
  if (typeof error !== "object" || error === null) return false
  const status = "status" in error ? (error as { readonly status?: unknown }).status : undefined
  if (status === 401 || status === 403) return true
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined
  return code === 7 || code === 16 || code === "PermissionDenied" || code === "Unauthenticated" ||
    code === "PERMISSION_DENIED" || code === "UNAUTHENTICATED"
}
