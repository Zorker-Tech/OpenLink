import { getOrCreateHostMachineId } from "../host-secret-store.ts"
import { createAuthRenewalEvents } from "./auth-renewal-events.ts"
import type { HostAuthRenewalEvent, HostAuthServiceOptions } from "./auth-service-contracts.ts"
import { resolveAuthCredentialSource } from "./auth-credential-source.ts"
import { InferenceCredentialStore } from "./inference-credential-store.ts"
import { SlateInferenceCredentialRenewer } from "./credential-renewer.ts"

export { EXPIRY_LEEWAY_MS, InferenceCredentialStore } from "./inference-credential-store.ts"
export type { HostAuthRenewalEvent } from "./auth-service-contracts.ts"

export class SlateCredentialsWaitingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SlateCredentialsWaitingError"
  }
}

export const SLATE_SHORTLIVED_CREDS_WAITING_MESSAGE = "Waiting for an inference credential. Slate's computer renews this automatically (no desktop required); this resolves on its own shortly."

export function createHostAuthService(options: HostAuthServiceOptions) {
  const env = options.env ?? process.env
  const store = new InferenceCredentialStore()
  const events = createAuthRenewalEvents(options.log)
  const source = resolveAuthCredentialSource(options, env)
  let firstCredentialPending = false

  const renewer = new SlateInferenceCredentialRenewer({
    getCredential: source.getCredential,
    renew: source.renew,
    setCredential: credential => {
      firstCredentialPending = store.getValidAccessToken() === null
      store.setCredential(credential)
    },
    onResult: result => {
      const isFirstCredential = result.outcome === "renewed" && firstCredentialPending
      firstCredentialPending = false
      if (result.outcome === "failed") {
        options.log(`inference-credential renewal failed (streak ${result.consecutiveFailures}): ${result.errorSummary ?? "unknown error"}`)
      }
      events.publish({ ...result, isFirstCredential })
    },
    retry: options.retry,
    clock: options.clock,
  })

  renewer.start()
  options.log(source.startupMessage)

  return {
    async getAccessToken(_options?: { readonly backendUrl?: string }): Promise<string> {
      let token = store.getValidAccessToken()
      if (token === null && source.hasRenewalCredential) {
        const renewed = await renewer.requestImmediateRenewal()
        if (renewed) token = store.getValidAccessToken()
      }
      if (token === null) throw new SlateCredentialsWaitingError(SLATE_SHORTLIVED_CREDS_WAITING_MESSAGE)
      return token
    },
    peekAccessToken: () => store.getValidAccessToken(),
    getLastRenewalEvent: events.getLast,
    getMachineId: options.getMachineId ?? (() => getOrCreateHostMachineId()),
    subscribeToRenewal: events.subscribe,
    dispose(): void {
      renewer.close()
      events.clearListeners()
    },
  }
}
