type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function notificationIdentity(params: UnknownRecord): { threadId: string; turnId: string } {
  const turn = asRecord(params.turn)
  return {
    threadId: stringValue(params.threadId) || stringValue(params.thread_id),
    turnId: stringValue(turn?.id) || stringValue(params.turnId) || stringValue(params.turn_id),
  }
}

/** Owns one Codex App Server turn's native terminal boundary. */
export class CodexTurnLifecycle {
  readonly promise: Promise<void>

  private resolvePromise!: () => void
  private rejectPromise!: (error: Error) => void
  private timer?: ReturnType<typeof setTimeout>
  private settled = false
  private turnId = ''
  private readonly signal: AbortSignal
  private readonly threadId: string
  private readonly idleTimeoutMs: number
  private readonly onIdle: () => void

  constructor(
    signal: AbortSignal,
    threadId: string,
    idleTimeoutMs: number,
    onIdle: () => void,
  ) {
    this.signal = signal
    this.threadId = threadId
    this.idleTimeoutMs = idleTimeoutMs
    this.onIdle = onIdle
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
    this.signal.addEventListener('abort', this.onAbort, { once: true })
    this.touch()
  }

  bindTurn(turnId: string): void {
    if (turnId && !this.turnId) this.turnId = turnId
  }

  onNotification(method: string, params: UnknownRecord): void {
    if (this.settled) return
    const identity = notificationIdentity(params)
    if (identity.threadId && identity.threadId !== this.threadId) return
    if (this.turnId && identity.turnId && identity.turnId !== this.turnId) return
    if (method === 'turn/started') this.bindTurn(identity.turnId)

    // App Server `error` may be retryable and is followed by the canonical
    // turn/completed terminal notification when it is not. Every matching
    // notification is activity, but only the native turn boundary settles.
    this.touch()
    if (method === 'turn/completed' || method === 'turn/failed') this.complete()
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.cleanup()
    this.rejectPromise(error)
  }

  cancel(): void {
    this.complete()
  }

  private readonly onAbort = () => {
    this.complete()
  }

  private complete(): void {
    if (this.settled) return
    this.settled = true
    this.cleanup()
    this.resolvePromise()
  }

  private touch(): void {
    if (this.settled) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      try { this.onIdle() } catch {}
      this.fail(new Error(`Codex turn stopped emitting events for ${this.idleTimeoutMs}ms`))
    }, this.idleTimeoutMs)
    this.timer.unref?.()
  }

  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.signal.removeEventListener('abort', this.onAbort)
  }
}
