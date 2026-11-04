import { executeCoalescedRequests } from "./request-coalescer-execution.ts"
import { takeCompatibleRequests } from "./request-coalescer-batch.ts"
import type { PendingCoalescedRequest, RequestCoalescerOptions } from "./request-coalescer-contracts.ts"

export type { RequestCoalescerOptions } from "./request-coalescer-contracts.ts"

export function createRequestCoalescer<Request, Result>(
  options: RequestCoalescerOptions<Request, Result>,
): (request: Request) => Promise<Result> {
  const batchLimit = Math.max(1, Math.floor(options.maxBatchSize))
  const pending: PendingCoalescedRequest<Request, Result>[] = []
  let draining = false

  async function drainQueue(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (pending.length > 0) {
        const batch = takeCompatibleRequests(pending, batchLimit, options.conflictKey)
        if (batch.length === 0) break
        await executeCoalescedRequests(batch, options)
      }
    } finally {
      draining = false
    }
  }

  return (request) => new Promise<Result>((resolve, reject) => {
    pending.push({ request, resolve, reject })
    void drainQueue()
  })
}
