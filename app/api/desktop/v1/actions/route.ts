import { runDesktopAction } from '@/lib/desktop-api/actions.server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
}

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Desktop action bridge.
 *
 * The web client imports server actions directly. A Vite renderer cannot, so
 * every action the shared UI uses is exposed here as a thin, allowlisted call.
 * The action implementation — validation, authorization, and persistence —
 * remains the single server-action module used by the web application.
 */
export async function POST(request: Request) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return Response.json(
      { error: { code: 'BODY_TOO_LARGE', message: 'Desktop action payload is too large' } },
      { status: 413, headers },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: { code: 'INVALID_BODY', message: 'Request body must be JSON' } },
      { status: 400, headers },
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(
      { error: { code: 'INVALID_BODY', message: 'Request body must be a JSON object' } },
      { status: 400, headers },
    )
  }

  const { action, input } = body as { action?: unknown; input?: unknown }
  if (typeof action !== 'string' || !action.trim()) {
    return Response.json(
      { error: { code: 'INVALID_ACTION', message: 'An action name is required' } },
      { status: 400, headers },
    )
  }

  const result = await runDesktopAction(action, input)
  if (result.ok) {
    return Response.json(
      {
        ok: true,
        ...(result.result !== undefined ? { result: result.result } : {}),
        ...(result.redirect ? { redirect: result.redirect } : {}),
      },
      { headers },
    )
  }
  return Response.json(
    { ok: false, error: { code: result.error, message: result.error } },
    { status: result.status, headers },
  )
}
