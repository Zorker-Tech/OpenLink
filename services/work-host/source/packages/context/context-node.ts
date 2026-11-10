import type { Context, ContextKey } from "./context-contracts.ts"

const EMPTY_VALUES: ReadonlyMap<symbol, unknown> = new Map()

function childController(parentSignal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (parentSignal.aborted) controller.abort(parentSignal.reason)
  else parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true })
  return controller
}

function contextNode(
  parent: Context | undefined,
  values: ReadonlyMap<symbol, unknown>,
  signal: AbortSignal | undefined,
  name: string | undefined,
): Context {
  const ownSignal = signal ?? parent?.signal ?? new AbortController().signal
  const node: Context = {
    signal: ownSignal,
    get canceled() {
      return ownSignal.aborted
    },
    get reason() {
      return ownSignal.reason
    },
    name,
    get<T>(key: ContextKey<T>): T {
      if (values.has(key.symbol)) return values.get(key.symbol) as T
      return parent === undefined ? key.defaultValue : parent.get(key)
    },
    with<T>(key: ContextKey<T>, value: T): Context {
      const nextValues = new Map(values)
      nextValues.set(key.symbol, value)
      return contextNode(node, nextValues, undefined, undefined)
    },
    withCancel(): [Context, (reason?: unknown) => void] {
      const controller = childController(ownSignal)
      return [contextNode(node, EMPTY_VALUES, controller.signal, undefined), (reason?: unknown) => controller.abort(reason)]
    },
    withTimeout(milliseconds: number): Context {
      const controller = childController(ownSignal)
      const child = contextNode(node, EMPTY_VALUES, controller.signal, undefined)
      const timer = setTimeout(() => controller.abort(deadlineExceededError()), milliseconds)
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
      return child
    },
    withDeadline(deadline: Date): Context {
      const remaining = deadline.getTime() - Date.now()
      if (remaining > 0) return node.withTimeout(remaining)
      const controller = childController(ownSignal)
      controller.abort(deadlineExceededError())
      return contextNode(node, EMPTY_VALUES, controller.signal, undefined)
    },
    withTimeoutAndCancel(milliseconds: number): [Context, (reason?: unknown) => void] {
      const [cancelable, cancel] = node.withCancel()
      return [cancelable.withTimeout(milliseconds), cancel]
    },
    withName(childName: string): Context {
      return contextNode(node, EMPTY_VALUES, undefined, childName)
    },
    withDetached(): Context {
      return contextNode(node, EMPTY_VALUES, new AbortController().signal, undefined)
    },
    getParent(): Context | undefined {
      return parent
    },
    getPath(): string[] {
      const names: string[] = []
      for (let current: Context | undefined = node; current !== undefined; current = current.getParent()) {
        if (current.name !== undefined && current.name.length > 0) names.unshift(current.name)
      }
      return names
    },
  }
  return node
}

export function createKey<T>(symbol: symbol, defaultValue: T): ContextKey<T> {
  return { symbol, defaultValue }
}

export function deadlineExceededError(): Error {
  return new Error("context deadline exceeded")
}

export function createContext(): Context {
  return contextNode(undefined, EMPTY_VALUES, new AbortController().signal, undefined)
}
