import type { ManagedAuthPort, RenewalEvent } from "./extension-contracts.ts"
import type { SlateManagedSkillsService } from "./managed-skills-service.ts"

export function bestEffortAccessToken(
  auth: Pick<ManagedAuthPort, "getAccessToken">,
  args?: unknown,
): () => Promise<string | null> {
  return async () => {
    try {
      const token = await auth.getAccessToken(args)
      return token.length > 0 ? token : null
    } catch {
      return null
    }
  }
}

export function startManagedSkillsWhenAuthenticated(options: {
  readonly auth: ManagedAuthPort
  readonly service?: SlateManagedSkillsService
  readonly startManagedSkills?: () => void
  readonly refreshManagedSkills?: () => void
}): () => void {
  let started = false
  let disposed = false

  const start = (): void => {
    if (started || disposed) return
    started = true
    const startService = options.startManagedSkills ?? (() => options.service?.start())
    startService()
  }

  const onRenewal = (event: RenewalEvent): void => {
    if (disposed || event.outcome !== "renewed") return
    if (!started) {
      if (options.auth.peekAccessToken() !== null) start()
      return
    }
    if (event.isFirstCredential) {
      const refreshService = options.refreshManagedSkills ?? (() => options.service?.onAuthenticationReady())
      refreshService()
    }
  }

  const unsubscribe = options.auth.subscribeToRenewal?.(onRenewal)
    ?? options.auth.onDidChange?.(() => onRenewal({ outcome: "renewed", isFirstCredential: true }))
    ?? (() => {})
  if (options.auth.peekAccessToken() !== null) start()

  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
  }
}
