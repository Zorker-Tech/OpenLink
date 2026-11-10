import assert from "node:assert/strict"
import { test } from "node:test"

import { createHostAuthService } from "../../source/host/auth/auth-service.ts"
import { createRetryPolicy, type Clock } from "../../source/host/extensions/scheduling.ts"
import type { InferenceCredential } from "../../source/host/auth/credential-renewer.ts"

function authClock(): { clock: Clock; firstWaitStarted: Promise<void>; fireNext(): void } {
  let announceFirstWait: (() => void) | undefined
  const firstWaitStarted = new Promise<void>(resolve => { announceFirstWait = resolve })
  const waits: Array<() => void> = []
  let isFirstWait = true
  return {
    clock: {
      now: () => Date.now(),
      monotonicNow: () => performance.now(),
      schedule: (_delayMs, callback) => {
        if (isFirstWait) {
          isFirstWait = false
          announceFirstWait?.()
        }
        let active = true
        waits.push(() => {
          if (!active) return
          active = false
          callback()
        })
        return { dispose() { active = false } }
      },
    },
    firstWaitStarted,
    fireNext() { waits.shift()?.() },
  }
}

test("a first renewal is marked once, listener failures are isolated, and request URLs cannot redirect renewal", async () => {
  const { clock, firstWaitStarted, fireNext } = authClock()
  const logs: string[] = []
  const renewals: Array<{ backendUrl: string; credential: string }> = []
  let releaseFirstRenewal: ((credential: InferenceCredential) => void) | undefined
  const firstRenewal = new Promise<InferenceCredential>(resolve => { releaseFirstRenewal = resolve })
  let noteSecondEvent: (() => void) | undefined
  const secondEventObserved = new Promise<void>(resolve => { noteSecondEvent = resolve })
  let renewalCount = 0

  const service = createHostAuthService({
    retry: createRetryPolicy(clock, { name: "auth-test", maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 }),
    clock,
    log: message => logs.push(message),
    env: { SLATE_INFERENCE_RENEWAL_CREDENTIAL: "renewal-secret" },
    backendUrl: "https://trusted.invalid",
    renewCredential: async (backendUrl, credential) => {
      renewals.push({ backendUrl, credential })
      renewalCount += 1
      if (renewalCount === 1) return firstRenewal
      return { accessToken: "second-token", expiresAtMs: Date.now() + 60_000 }
    },
  })

  const seen: Array<{ outcome: string; isFirstCredential: boolean }> = []
  service.subscribeToRenewal(() => { throw new Error("observer failed") })
  service.subscribeToRenewal(event => {
    seen.push({ outcome: event.outcome, isFirstCredential: event.isFirstCredential })
    if (seen.length === 2) noteSecondEvent?.()
  })
  try {
    releaseFirstRenewal?.({ accessToken: "first-token", expiresAtMs: Date.now() + 60_000 })
    await firstWaitStarted

    assert.deepEqual(seen, [{ outcome: "renewed", isFirstCredential: true }])
    assert.equal(service.getLastRenewalEvent()?.isFirstCredential, true)
    assert.equal(logs.some(message => message.includes("credential renewal listener failed")), true)

    const tokenBeforeRefresh = await service.getAccessToken({ backendUrl: "https://caller-controlled.invalid" })
    assert.equal(tokenBeforeRefresh, "first-token")
    fireNext()
    await secondEventObserved
    const token = await service.getAccessToken()
    assert.equal(token, "second-token")
    assert.deepEqual(renewals, [
      { backendUrl: "https://trusted.invalid", credential: "renewal-secret" },
      { backendUrl: "https://trusted.invalid", credential: "renewal-secret" },
    ])
    assert.deepEqual(seen, [
      { outcome: "renewed", isFirstCredential: true },
      { outcome: "renewed", isFirstCredential: false },
    ])
    assert.equal(service.getLastRenewalEvent()?.isFirstCredential, false)
  } finally {
    service.dispose()
  }
})
