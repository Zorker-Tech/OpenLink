import {
  PlatformAuthClient,
  registerOAuthPublicClient,
} from '@vtslx/platform-sdk/auth'

import type { DesktopHyditeConfig } from './api'
import type { DesktopBridge } from './desktop-bridge'

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function resolveClientId(config: DesktopHyditeConfig) {
  if (config.clientId) return config.clientId
  const registration = await registerOAuthPublicClient({
    issuer: config.issuer,
    clientName: 'OpenLink Desktop',
    redirectUris: [config.redirectUri],
    scopes: config.scopes,
    allowInsecureLoopback: true,
  })
  return registration.clientId
}

export interface HyditeLoginTokens {
  idToken: string
  accessToken: string
  nonce: string
}

/**
 * Desktop Cloud sign-in.
 *
 * Hydite is a standard OAuth authorization-code + PKCE issuer. The system
 * browser performs the interactive flow; the Electron main process captures
 * the one-shot loopback redirect and hands the code back to this renderer,
 * which owns the PKCE verifier. The refresh token never leaves the process.
 */
export async function performHyditeLogin(
  config: DesktopHyditeConfig,
  bridge: DesktopBridge,
): Promise<HyditeLoginTokens> {
  const clientId = await resolveClientId(config)
  const client = new PlatformAuthClient({
    issuer: config.issuer,
    clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    allowInsecureLoopback: true,
  })

  const request = await client.createAuthorizationRequest()
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const providerNonce = await sha256Hex(nonce)
  const authorizationUrl = new URL(request.url)
  authorizationUrl.searchParams.set('nonce', providerNonce)

  try {
    const { code } = await bridge.auth.hydite({
      authorizationUrl: authorizationUrl.toString(),
      redirectUri: config.redirectUri,
      state: request.state,
    })
    const tokens = await client.exchangeAuthorizationCode({
      code,
      codeVerifier: request.codeVerifier,
    })
    if (!tokens.idToken) throw new Error('Hydite did not return an ID token')
    return { idToken: tokens.idToken, accessToken: tokens.accessToken, nonce }
  } finally {
    await client.revoke().catch(() => undefined)
  }
}

export async function exchangeHyditeSession(tokens: HyditeLoginTokens): Promise<void> {
  const response = await fetch('/api/desktop/v1/auth/hydite/exchange', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(tokens),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string } }
      | null
    throw new Error(payload?.error?.code || 'HYDITE_EXCHANGE_FAILED')
  }
}
