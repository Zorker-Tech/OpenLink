export class BrowserHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
    readonly recoverable = false,
  ) {
    super(message)
    this.name = 'BrowserHostError'
  }
}

export function toBrowserHostError(error: unknown): BrowserHostError {
  if (error instanceof BrowserHostError) return error
  return new BrowserHostError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
}
