export interface RequestCoalescerOptions<Request, Result> {
  readonly maxBatchSize: number
  readonly run: (requests: Request[]) => Promise<Result[]>
  readonly conflictKey?: (request: Request) => string | undefined
  readonly shouldSplitOnError?: (error: unknown) => boolean
}

export interface PendingCoalescedRequest<Request, Result> {
  readonly request: Request
  readonly resolve: (value: Result) => void
  readonly reject: (error: unknown) => void
}
