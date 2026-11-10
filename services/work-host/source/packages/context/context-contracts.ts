export interface ContextKey<T> {
  readonly symbol: symbol
  readonly defaultValue: T
}

export interface Context {
  readonly signal: AbortSignal
  readonly canceled: boolean
  readonly reason: unknown
  readonly name: string | undefined
  get<T>(key: ContextKey<T>): T
  with<T>(key: ContextKey<T>, value: T): Context
  withCancel(): [Context, (reason?: unknown) => void]
  withTimeout(ms: number): Context
  withDeadline(deadline: Date): Context
  withTimeoutAndCancel(ms: number): [Context, (reason?: unknown) => void]
  withName(name: string): Context
  withDetached(): Context
  getParent(): Context | undefined
  getPath(): string[]
}
