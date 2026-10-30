import { CloudConnectionError } from '@/lib/platform-cloud-connection.server'
import { CloudProjectLinkError } from '@/lib/platform-cloud-project'
import { getCloudComputerInfo } from '@/lib/platform-cloud-host.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'

export const runtime = 'nodejs'

const headers = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  if (getRuntimeMode() !== 'cloud') {
    return Response.json({ error: 'CLOUD_COMPUTER_UNAVAILABLE' }, { status: 404, headers })
  }

  const { projectId } = await params
  try {
    const computer = await getCloudComputerInfo(projectId)
    return Response.json({ computer }, { headers })
  } catch (error) {
    const known = error instanceof CloudConnectionError || error instanceof CloudProjectLinkError
    return Response.json(
      { error: known ? error.message : 'CLOUD_COMPUTER_UNAVAILABLE' },
      { status: known ? error.status : 502, headers },
    )
  }
}
