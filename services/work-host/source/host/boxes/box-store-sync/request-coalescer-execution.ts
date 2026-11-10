import { BoxStoreSyncError } from "./box-store-sync-error.ts"
import type { PendingCoalescedRequest, RequestCoalescerOptions } from "./request-coalescer-contracts.ts"

async function runSeparately<Request, Result>(
  batch: PendingCoalescedRequest<Request, Result>[],
  run: RequestCoalescerOptions<Request, Result>["run"],
): Promise<void> {
  for (const pending of batch) {
    try {
      const results = await run([pending.request])
      const result = results[0]
      if (result === undefined) throw new BoxStoreSyncError("Batched request returned no result for its request")
      pending.resolve(result)
    } catch (error) {
      pending.reject(error)
    }
  }
}

export async function executeCoalescedRequests<Request, Result>(
  batch: PendingCoalescedRequest<Request, Result>[],
  options: RequestCoalescerOptions<Request, Result>,
): Promise<void> {
  try {
    const results = await options.run(batch.map((pending) => pending.request))
    if (results.length !== batch.length) {
      throw new BoxStoreSyncError(`Batched request returned ${results.length} results for ${batch.length} requests`)
    }
    batch.forEach((pending, index) => pending.resolve(results[index] as Result))
  } catch (error) {
    if (batch.length > 1 && (options.shouldSplitOnError?.(error) ?? false)) {
      await runSeparately(batch, options.run)
      return
    }
    for (const pending of batch) pending.reject(error)
  }
}
