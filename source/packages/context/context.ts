/**
 * The ambient context a Work operation runs inside.
 *
 * A request, a run, a scheduled job and a Box command all travel with one of these: the
 * cancellation they can be stopped by, the deadline they must finish within, the name that shows
 * up in diagnostics, and the values scoped to them. Values are inherited down the chain, so a
 * child sees everything its ancestors carry while its own additions stay invisible to siblings.
 */

export interface ContextKey<T> {
  readonly symbol: symbol
  readonly defaultValue: T
}

export interface Context {
  /** Cancellation for this context, linked to the cancellation of its ancestors. */
  readonly signal: AbortSignal
  readonly canceled: boolean
  readonly reason: unknown
  /** Diagnostic name: span names and `ctx=` log paths are built from it. */
  readonly name: string | undefined
  get<T>(key: ContextKey<T>): T
  /**
   * A child carrying `value`. The child itself is unnamed — names are set with `withName`, and
   * descendants still read the chain through `getPath`.
   */
  with<T>(key: ContextKey<T>, value: T): Context
  /** A child canceled by the returned function, or by anything that cancels this context. */
  withCancel(): [Context, (reason?: unknown) => void]
  withTimeout(ms: number): Context
  withDeadline(deadline: Date): Context
  withTimeoutAndCancel(ms: number): [Context, (reason?: unknown) => void]
  withName(name: string): Context
  /** A child that keeps this context's values but none of its cancellation. */
  withDetached(): Context
  getParent(): Context | undefined
  /** Names from the root down to this context, unnamed steps skipped. */
  getPath(): string[]
}

/** Declares a value slot. `defaultValue` applies wherever nothing has set a value. */
export function createKey<T>(symbol: symbol, defaultValue: T): ContextKey<T> {
  return { symbol, defaultValue }
}

/** The abort reason a context carries once its deadline passes. */
export function deadlineExceededError(): Error {
  return new Error("context deadline exceeded")
}

/** Never mutated; shared so child contexts that add no values allocate nothing. */
const NO_VALUES: ReadonlyMap<symbol, unknown> = new Map()

/**
 * A controller that follows `parentSignal`: aborting the parent aborts the child with the same
 * reason, and aborting a parent that is already aborted aborts the child immediately.
 */
function followAbort(parentSignal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (parentSignal.aborted) controller.abort(parentSignal.reason)
  else parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true })
  return controller
}

class ContextImpl implements Context {
  readonly signal: AbortSignal
  readonly name: string | undefined
  private readonly parent: Context | undefined
  private readonly values: ReadonlyMap<symbol, unknown>

  constructor(
    parent: Context | undefined,
    values: ReadonlyMap<symbol, unknown>,
    signal: AbortSignal | undefined,
    name: string | undefined,
  ) {
    this.parent = parent
    this.values = values
    this.signal = signal ?? parent?.signal ?? new AbortController().signal
    this.name = name
  }

  get canceled(): boolean {
    return this.signal.aborted
  }

  get reason(): unknown {
    return this.signal.reason
  }

  get<T>(key: ContextKey<T>): T {
    if (this.values.has(key.symbol)) return this.values.get(key.symbol) as T
    return this.parent?.get(key) ?? key.defaultValue
  }

  with<T>(key: ContextKey<T>, value: T): Context {
    const values = new Map(this.values)
    values.set(key.symbol, value)
    return new ContextImpl(this, values, undefined, undefined)
  }

  withCancel(): [Context, (reason?: unknown) => void] {
    const controller = followAbort(this.signal)
    const child = new ContextImpl(this, NO_VALUES, controller.signal, undefined)
    return [child, (reason?: unknown) => controller.abort(reason)]
  }

  withTimeout(ms: number): Context {
    const controller = followAbort(this.signal)
    const child = new ContextImpl(this, NO_VALUES, controller.signal, undefined)
    const timer = setTimeout(() => controller.abort(deadlineExceededError()), ms)
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
    return child
  }

  withDeadline(deadline: Date): Context {
    const remaining = deadline.getTime() - Date.now()
    if (remaining > 0) return this.withTimeout(remaining)
    const controller = followAbort(this.signal)
    controller.abort(deadlineExceededError())
    return new ContextImpl(this, NO_VALUES, controller.signal, undefined)
  }

  withTimeoutAndCancel(ms: number): [Context, (reason?: unknown) => void] {
    const [cancelable, cancel] = this.withCancel()
    return [cancelable.withTimeout(ms), cancel]
  }

  withName(name: string): Context {
    return new ContextImpl(this, NO_VALUES, undefined, name)
  }

  withDetached(): Context {
    return new ContextImpl(this, NO_VALUES, new AbortController().signal, undefined)
  }

  getParent(): Context | undefined {
    return this.parent
  }

  getPath(): string[] {
    const path: string[] = []
    for (let current: Context | undefined = this; current !== undefined; current = current.getParent()) {
      if (current.name !== undefined && current.name.length > 0) path.unshift(current.name)
    }
    return path
  }
}

/** The root of a context chain: uncancelable until something derives a cancelable child from it. */
export function createContext(): Context {
  return new ContextImpl(undefined, NO_VALUES, undefined, undefined)
}
