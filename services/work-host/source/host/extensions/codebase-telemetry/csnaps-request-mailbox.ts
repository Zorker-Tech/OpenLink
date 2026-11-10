import {
  CsnapsResponseDecoder,
  type CsnapsErrorCode,
  type CsnapsResponse,
} from "./csnaps-protocol.ts"

interface PendingReply {
  readonly method: string
  readonly signal: AbortSignal
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly onAbort: () => void
}

export interface CsnapsRequestHandle {
  readonly id: number
  readonly response: Promise<unknown>
}

export interface CsnapsRequestMailboxErrors {
  process(message: string, cause?: unknown): Error
  request(method: string, code: CsnapsErrorCode): Error
}

/** Correlates framed helper answers with the calls waiting for them. */
export class CsnapsRequestMailbox {
  private readonly decoder = new CsnapsResponseDecoder()
  private readonly pending = new Map<number, PendingReply>()
  private nextId = 0

  constructor(private readonly errors: CsnapsRequestMailboxErrors) {}

  open(method: string, signal: AbortSignal, onFatal: (error: Error) => void): CsnapsRequestHandle {
    const id = this.nextId++
    const reply = Promise.withResolvers<unknown>()
    const onAbort = (): void => {
      const waiting = this.pending.get(id)
      if (waiting === undefined) return
      this.pending.delete(id)
      signal.removeEventListener("abort", onAbort)
      const timedOut = signal.reason instanceof Error && signal.reason.name === "DeadlineExceededError"
      const error = this.errors.process(
        `csnaps ${method} request ${timedOut ? "timed out" : "cancelled"}`,
        signal.reason,
      )
      reply.reject(error)
      onFatal(error)
    }

    this.pending.set(id, {
      method,
      signal,
      resolve: reply.resolve,
      reject: reply.reject,
      onAbort,
    })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    return { id, response: reply.promise }
  }

  accept(chunk: Buffer): void {
    const answers = this.decoder.decode(chunk)
    const seen = new Set<number>()
    for (const answer of answers) {
      if (seen.has(answer.id)) throw this.errors.process("csnaps returned a duplicate request ID")
      if (!this.pending.has(answer.id)) throw this.errors.process("csnaps returned an unknown request ID")
      seen.add(answer.id)
    }
    for (const answer of answers) this.settle(answer)
  }

  rejectAll(error: Error): void {
    for (const waiting of this.pending.values()) {
      waiting.signal.removeEventListener("abort", waiting.onAbort)
      waiting.reject(error)
    }
    this.pending.clear()
  }

  assertComplete(): void {
    this.decoder.assertComplete()
  }

  private settle(answer: CsnapsResponse): void {
    const waiting = this.pending.get(answer.id)
    if (waiting === undefined) throw this.errors.process("csnaps returned an unknown request ID")
    this.pending.delete(answer.id)
    waiting.signal.removeEventListener("abort", waiting.onAbort)
    if (answer.ok) waiting.resolve(answer.result)
    else waiting.reject(this.errors.request(waiting.method, answer.error))
  }
}
