import type { PendingCoalescedRequest } from "./request-coalescer-contracts.ts"

export function takeCompatibleRequests<Request, Result>(
  queue: PendingCoalescedRequest<Request, Result>[],
  batchLimit: number,
  conflictKey?: (request: Request) => string | undefined,
): PendingCoalescedRequest<Request, Result>[] {
  const selected: PendingCoalescedRequest<Request, Result>[] = []
  const selectedKeys = new Set<string>()
  const deferred: PendingCoalescedRequest<Request, Result>[] = []

  while (selected.length < batchLimit) {
    const next = queue.shift()
    if (next === undefined) break
    const key = conflictKey?.(next.request)
    if (key !== undefined && selectedKeys.has(key)) {
      deferred.push(next)
      continue
    }
    if (key !== undefined) selectedKeys.add(key)
    selected.push(next)
  }
  queue.unshift(...deferred)
  return selected
}
