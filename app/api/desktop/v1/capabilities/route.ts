import { desktopCapabilities } from '@/lib/desktop-api/capabilities.server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Desktop capability handshake.
 *
 * A desktop client may be older or newer than the server it connects to. The
 * response is intentionally additive and public: it exposes only the contract
 * version, feature list, and public runtime configuration.
 */
export async function GET() {
  return Response.json(desktopCapabilities(), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  })
}
