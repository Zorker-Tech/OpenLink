import type { InferenceCredential } from "./credential-renewer.ts"

export const EXPIRY_LEEWAY_MS = 30_000

/** Hold the latest usable inference token and treat it as stale before its exact expiry. */
export class InferenceCredentialStore {
  private credential: InferenceCredential | undefined

  setCredential(credential: InferenceCredential): void {
    if (credential.accessToken.length > 0) this.credential = credential
  }

  getValidAccessToken(now = Date.now()): string | null {
    const current = this.credential
    if (current === undefined || now >= current.expiresAtMs - EXPIRY_LEEWAY_MS) return null
    return current.accessToken
  }

  hasValidCredential(now = Date.now()): boolean {
    return this.getValidAccessToken(now) !== null
  }

  clear(): void { this.credential = undefined }
}
