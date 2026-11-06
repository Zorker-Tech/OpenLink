import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 16 * 1024
const MAX_NONCE_LENGTH = 512

function fail(status: number, code: string) {
  return Response.json({ ok: false, error: { code, message: code } }, { status, headers })
}

/**
 * Desktop Hydite exchange.
 *
 * The desktop performs the OAuth PKCE flow with the public Hydite client and
 * posts the resulting ID token here. Supabase Auth verifies the token's
 * signature, issuer, audience, and nonce claim before creating a session, and
 * the response sets the same first-party cookies the web login uses.
 */
export async function POST(request: Request) {
  if (getRuntimeMode() !== 'cloud') return fail(404, 'HYDITE_AUTH_UNAVAILABLE')

  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return fail(413, 'BODY_TOO_LARGE')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail(400, 'INVALID_BODY')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'INVALID_BODY')

  const { idToken, accessToken, nonce } = body as {
    idToken?: unknown
    accessToken?: unknown
    nonce?: unknown
  }
  if (
    typeof idToken !== 'string' ||
    !idToken ||
    idToken.length > MAX_TOKEN_LENGTH ||
    (accessToken !== undefined && (typeof accessToken !== 'string' || accessToken.length > MAX_TOKEN_LENGTH)) ||
    (nonce !== undefined && (typeof nonce !== 'string' || !nonce || nonce.length > MAX_NONCE_LENGTH))
  ) {
    return fail(400, 'INVALID_HYDITE_TOKENS')
  }

  const provider =
    process.env.OPENLINK_CLOUD_SUPABASE_AUTH_PROVIDER?.trim() || 'custom:hydite'
  if (!/^custom:[a-z0-9][a-z0-9:-]{0,48}[a-z0-9]$/.test(provider)) {
    return fail(503, 'HYDITE_AUTH_NOT_CONFIGURED')
  }

  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider,
      token: idToken,
      ...(typeof accessToken === 'string' && accessToken ? { access_token: accessToken } : {}),
      ...(typeof nonce === 'string' && nonce ? { nonce } : {}),
    })
    if (error || !data.user) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[desktop-auth] Hydite exchange rejected', {
          code: error?.code ?? null,
          status: error?.status ?? null,
        })
      }
      return fail(401, 'HYDITE_EXCHANGE_FAILED')
    }
    return Response.json(
      {
        ok: true,
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
        },
      },
      { headers },
    )
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[desktop-auth] Hydite exchange failed', {
        message: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      })
    }
    return fail(503, 'HYDITE_EXCHANGE_UNAVAILABLE')
  }
}
