import { CloudConnectionError, disconnectCloudConnection, getCloudConnection } from '@/lib/platform-cloud-connection.server'

export const runtime = 'nodejs'
const headers = { 'cache-control': 'private, no-store' }
type Context = { params: Promise<{ connectionId: string }> }
function failure(error: unknown) {
  const known = error instanceof CloudConnectionError
  return Response.json({ error: { code: known ? error.code : 'CLOUD_CONNECTION_UNAVAILABLE' } },
    { status: known ? error.status : 503, headers })
}
export async function GET(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { sdk, state } = await getCloudConnection(connectionId)
    if (!['active', 'refreshing'].includes(state)) return Response.json({ connected: false, state }, { headers })
    const identity = await sdk.verifyIdentity()
    return Response.json({ connected: true, subject: identity.sub }, { headers })
  } catch (error) { return failure(error) }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const origin = new URL(process.env.OPENLINK_APP_URL ?? '')
    if (origin.protocol !== 'https:' || request.headers.get('origin') !== origin.origin)
      return Response.json({ error: { code: 'ORIGIN_NOT_ALLOWED' } }, { status: 403, headers })
    const result = await disconnectCloudConnection((await context.params).connectionId)
    return Response.json(result, { status: result.revoked ? 200 : 202, headers })
  } catch (error) { return failure(error) }
}
