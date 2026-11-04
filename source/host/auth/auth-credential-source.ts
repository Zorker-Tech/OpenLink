import { getConfiguredBackendUrl } from "../../shared/node/slate-token.ts"
import {
  readDevInferenceCredentialFile,
  renewBoxInferenceCredential,
  SLATE_DEV_INFERENCE_TOKEN_FILE_ENV,
  SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV,
  type InferenceCredential,
} from "./credential-renewer.ts"
import type { HostAuthServiceOptions } from "./auth-service-contracts.ts"

export interface AuthCredentialSource {
  readonly hasRenewalCredential: boolean
  readonly startupMessage: string
  getCredential(): string | null
  renew(credential: string): Promise<InferenceCredential>
}

/** Choose the credential source once, while reading rotating backend credentials on every renewal. */
export function resolveAuthCredentialSource(
  options: HostAuthServiceOptions,
  env: NodeJS.ProcessEnv,
): AuthCredentialSource {
  const devFile = env[SLATE_DEV_INFERENCE_TOKEN_FILE_ENV]?.trim() ?? ""
  const useDevFile = devFile.length > 0
  const hasRenewalCredential = useDevFile || (env[SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV]?.trim() ?? "").length > 0

  if (useDevFile) {
    return {
      hasRenewalCredential,
      startupMessage: `DEV inference-credential renewer started, reading short-lived tokens from ${devFile} (dev:box-docker local loop)`,
      getCredential: () => devFile,
      renew: () => (options.readDevCredential ?? (path => readDevInferenceCredentialFile({ path })))(devFile),
    }
  }

  return {
    hasRenewalCredential,
    startupMessage: hasRenewalCredential
      ? "inference-credential renewer started (backend self-renewal is the sole inference-credential source)"
      : "inference-credential renewer started, but no renewal credential was delivered into the box; inference is unavailable until the box is re-provisioned with one",
    getCredential: () => env[SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV]?.trim() ?? null,
    renew: credential => (options.renewCredential ?? ((backendUrl, value) => renewBoxInferenceCredential({ backendUrl, credential: value })))(
      options.backendUrl ?? getConfiguredBackendUrl(env),
      credential,
    ),
  }
}
