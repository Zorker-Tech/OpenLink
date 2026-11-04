export const SLATE_DEFAULT_BACKEND_URL = "https://api.slate.invalid"
export const SLATE_PRODUCTION_AUTH_CLIENT_ID = ""
export const SLATE_DEVELOPMENT_AUTH_CLIENT_ID = ""

export function configuredSlateBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(env.SLATE_BACKEND_URL ?? SLATE_DEFAULT_BACKEND_URL).toString()
}

export function slateAuthClientId(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicitClientId = env.SLATE_AUTH_CLIENT_ID
  if (explicitClientId != null && explicitClientId.length > 0) return explicitClientId

  const host = new URL(backendUrl).hostname
  const developmentHosts = ["localhost", "127.0.0.1", "dev-staging.slate.invalid"]
  const isDevelopmentHost = developmentHosts.includes(host) || host.endsWith(".lclhst.build")
  return isDevelopmentHost ? SLATE_DEVELOPMENT_AUTH_CLIENT_ID : SLATE_PRODUCTION_AUTH_CLIENT_ID
}

export function usesSlateDevelopmentAuth(backendUrl: string): boolean {
  return slateAuthClientId(backendUrl) !== SLATE_PRODUCTION_AUTH_CLIENT_ID
}
