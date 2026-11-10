import type { TunnelConfig } from "./box-connection.ts"

export const ANYRUN_NETWORK_TOKEN_HEADER = "x-slate-network-token"

function sameHeaders(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const a = left ?? {}
  const b = right ?? {}
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => Object.hasOwn(b, key) && a[key] === b[key])
}

export function configsEqual(left: TunnelConfig | null, right: TunnelConfig | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.url === right.url
    && left.bearer === right.bearer
    && left.allowPrivateTargets === right.allowPrivateTargets
    && sameHeaders(left.headers, right.headers)
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TunnelConfig | null {
  const url = env.SLATE_EGRESS_TUNNEL_URL
  const bearer = env.SLATE_EGRESS_TUNNEL_BEARER
  if (url == null || url.length === 0 || bearer == null || bearer.length === 0) return null

  const networkToken = env.SLATE_EGRESS_TUNNEL_NETWORK_TOKEN
  const headers = networkToken == null || networkToken.length === 0
    ? undefined
    : { [ANYRUN_NETWORK_TOKEN_HEADER]: networkToken }

  return {
    url,
    bearer,
    ...(headers === undefined ? {} : { headers }),
    allowPrivateTargets: env.SLATE_EGRESS_TUNNEL_ALLOW_PRIVATE === "1",
  }
}

export function desiredTunnelConfig(
  enabled: boolean,
  env: NodeJS.ProcessEnv | undefined,
  boxConfig: TunnelConfig | null,
): TunnelConfig | null {
  if (!enabled) return null
  return configFromEnv(env) ?? boxConfig
}
