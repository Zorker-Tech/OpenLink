import { loadDesktopBootstrap } from '@/lib/desktop-api/bootstrap.server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
}

/**
 * Desktop page bootstrap.
 *
 * The web application continues to render its pages as React Server Components.
 * The desktop renderer is a Vite client and therefore needs the same page data
 * as JSON. Each loader reuses the same server-side domain functions as the page
 * it mirrors; it never invents a second data path.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const [{ path = [] }, url] = await Promise.all([context.params, Promise.resolve(new URL(request.url))])
  try {
    const result = await loadDesktopBootstrap(path, url.searchParams)
    if (result.ok) return Response.json(result.data, { headers })
    return Response.json(
      {
        error: { code: result.code, message: result.message },
        ...(result.redirect ? { redirect: result.redirect } : {}),
      },
      { status: result.status, headers },
    )
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'DESKTOP_BOOTSTRAP_FAILED',
          message: error instanceof Error ? error.message : 'Desktop bootstrap failed',
        },
      },
      { status: 500, headers },
    )
  }
}
