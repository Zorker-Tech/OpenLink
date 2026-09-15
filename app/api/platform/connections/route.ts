import { CloudConnectionError, listCloudConnections } from '@/lib/platform-cloud-connection.server'

export const runtime = 'nodejs'
export async function GET() {
  const headers = { 'cache-control': 'private, no-store' }
  try { return Response.json({ connections: await listCloudConnections() }, { headers }) }
  catch (error) {
    const known = error instanceof CloudConnectionError
    return Response.json({ error: { code: known ? error.code : 'CLOUD_CONNECTION_UNAVAILABLE' } },
      { status: known ? error.status : 503, headers })
  }
}
