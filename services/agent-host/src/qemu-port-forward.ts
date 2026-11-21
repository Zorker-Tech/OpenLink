import { setTimeout as delay } from 'node:timers/promises'

export function isQemuForwardConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNREFUSED'
}

// QEMU's forwarded listeners can briefly refuse connects during reattach.
// Retry only a refused connect, before any request bytes were sent.
export async function retryQemuForward<T>(operation: () => Promise<T>): Promise<T> {
  for (const interval of [100, 250, 500, 800]) {
    try {
      return await operation()
    } catch (error) {
      if (!isQemuForwardConnectionRefused(error)) throw error
      await delay(interval)
    }
  }
  return operation()
}
