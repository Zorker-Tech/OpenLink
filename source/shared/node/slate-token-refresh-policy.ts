import { isSlateAccessTokenNearExpiry } from "./slate-token-expiration.ts"
import { usesSlateDevelopmentAuth } from "./slate-backend-configuration.ts"

export function shouldRefreshSlateAccessToken(backendUrl: string, accessToken: string): boolean {
  return isSlateAccessTokenNearExpiry(accessToken) || usesSlateDevelopmentAuth(backendUrl)
}
