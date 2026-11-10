import type { HostAuthRenewalEvent } from "./auth-service-contracts.ts"

/** Publish renewal state without allowing one observer to interrupt the others. */
export function createAuthRenewalEvents(log: (message: string) => void) {
  const observers = new Set<(event: HostAuthRenewalEvent) => void>()
  let mostRecent: HostAuthRenewalEvent | null = null

  function publish(event: HostAuthRenewalEvent): void {
    mostRecent = event
    for (const observer of [...observers]) {
      try {
        observer(event)
      } catch (error) {
        log(`credential renewal listener failed: ${String(error)}`)
      }
    }
  }

  return {
    publish,
    getLast: () => mostRecent,
    subscribe(listener: (event: HostAuthRenewalEvent) => void): () => void {
      observers.add(listener)
      return () => observers.delete(listener)
    },
    clearListeners: () => observers.clear(),
  }
}
