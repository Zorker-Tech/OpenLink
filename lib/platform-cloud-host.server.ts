import 'server-only'

import {
  authenticatedCloudContext,
  CloudConnectionError,
  getCloudConnection,
  listCloudConnections,
} from '@/lib/platform-cloud-connection.server'
import { CloudProjectLinkError } from '@/lib/platform-cloud-project'
import { cloudProjectLinksForRequest } from '@/lib/platform-cloud-project.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const chatSessionId = /^[A-Za-z0-9]{11}$/

function cloudHostConfiguration() {
  const configuredUrl = process.env.OPENLINK_CLOUD_HOST_URL?.trim()
  const token = process.env.OPENLINK_CLOUD_HOST_API_TOKEN?.trim()
  if (!configuredUrl || !token) throw new CloudConnectionError(503, 'CLOUD_SDK_HOST_NOT_CONFIGURED')

  let url: URL
  try {
    url = new URL(configuredUrl)
  } catch {
    throw new CloudConnectionError(503, 'CLOUD_SDK_HOST_NOT_CONFIGURED')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((!loopback && url.protocol !== 'https:') || (loopback && url.protocol !== 'http:')
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new CloudConnectionError(503, 'CLOUD_SDK_HOST_NOT_CONFIGURED')
  }
  return { url: url.origin, token }
}

async function cloudComputerAuthorization(projectId: string, requireWrite: boolean, requestedConnectionId?: string) {
  if (getRuntimeMode() !== 'cloud') throw new CloudConnectionError(404, 'CLOUD_COMPUTER_UNAVAILABLE')
  if (!uuid.test(projectId)) throw new CloudProjectLinkError(400, 'INVALID_PROJECT_ID')
  if (requestedConnectionId !== undefined && !uuid.test(requestedConnectionId)) {
    throw new CloudConnectionError(400, 'INVALID_CLOUD_CONNECTION_ID')
  }

  const [{ user }, connections, links] = await Promise.all([
    authenticatedCloudContext(),
    listCloudConnections(),
    cloudProjectLinksForRequest(),
  ])
  const current = await links.read(projectId)
  const platformProjectRef = current.link?.platform_project_ref
  if (!platformProjectRef) throw new CloudProjectLinkError(404, 'CLOUD_PROJECT_NOT_LINKED')

  const connectionRecord = connections.find((connection) =>
    (requestedConnectionId === undefined || connection.id === requestedConnectionId)
      && ['active', 'refreshing', 'reauth_required'].includes(connection.state),
  )
  if (!connectionRecord) throw new CloudConnectionError(409, 'CLOUD_CONNECTION_INACTIVE')
  if (connectionRecord.state === 'reauth_required') {
    throw new CloudConnectionError(409, 'CLOUD_CONNECTION_REAUTH_REQUIRED')
  }

  const connection = await getCloudConnection(connectionRecord.id)
  if (connection.state === 'reauth_required') {
    throw new CloudConnectionError(409, 'CLOUD_CONNECTION_REAUTH_REQUIRED')
  }
  if (!['active', 'refreshing'].includes(connection.state)) {
    throw new CloudConnectionError(409, 'CLOUD_CONNECTION_INACTIVE')
  }
  const project = (await connection.sdk.listProjects()).find(
    (item) => item.id.toLowerCase() === platformProjectRef.toLowerCase(),
  )
  if (!project) throw new CloudProjectLinkError(403, 'CLOUD_PROJECT_NOT_ACCESSIBLE')

  const sdkProject = await connection.sdk.project({
    openlinkUserId: user.id,
    openlinkProjectId: projectId,
    platformProjectRef,
  })
  const accessToken = await connection.sdk.auth.getAccessToken(120)
  const tokenSet = await connection.sdk.auth.tokenStore.load()
  if (!tokenSet || tokenSet.accessToken !== accessToken || tokenSet.expiresAt <= Date.now() + 30_000
    || !tokenSet.scope.includes('computer:read')) {
    throw new CloudConnectionError(409, 'CLOUD_CONNECTION_INACTIVE')
  }
  if (requireWrite && !tokenSet.scope.includes('computer:write')) {
    throw new CloudConnectionError(403, 'CLOUD_COMPUTER_PERMISSION_REQUIRED')
  }
  const identity = await connection.sdk.verifyIdentity()
  return {
    userId: user.id,
    platformProjectRef: sdkProject.projectRef,
    expectedSubject: identity.sub,
    accessToken,
    scope: tokenSet.scope,
    expiresAt: tokenSet.expiresAt,
  }
}

function safeHostPath(path: string) {
  if (path === '/v1/computer/info') return path
  if (path === '/v1/computer/services' || path === '/v1/computer/services/tunnel') return path
  if (/^\/v1\/agent\/sessions\/[A-Za-z0-9]{11}\/(?:events|lease|resources)$/.test(path)) return path
  if (/^\/v1\/agent\/sessions\/[A-Za-z0-9]{11}\/(?:control|cancel)$/.test(path)) return path
  throw new CloudConnectionError(400, 'INVALID_CLOUD_HOST_REQUEST')
}

/** Authenticated internal request to the Cloud Computer Host without SDK credentials. */
export async function cloudComputerHostRequest(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
  if (getRuntimeMode() !== 'cloud') throw new CloudConnectionError(404, 'CLOUD_COMPUTER_UNAVAILABLE')
  const host = cloudHostConfiguration()
  return fetch(`${host.url}${safeHostPath(path)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.token}`,
      'content-type': 'application/json',
      accept: 'application/json, application/x-ndjson',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    redirect: 'manual',
    ...(signal ? { signal } : { signal: AbortSignal.timeout(path.startsWith('/v1/computer/services') ? 60_000 : 35_000) }),
  })
}

/** Open a user-bound Cloud Computer SDK request; credentials exist only in this host-to-host call. */
export async function cloudComputerSdkRequest(
  projectId: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  requestedConnectionId?: string,
) {
  const host = cloudHostConfiguration()
  const authorization = await cloudComputerAuthorization(
    projectId,
    path !== '/v1/computer/info' && path !== '/v1/computer/services',
    requestedConnectionId,
  )
  const hostPath = safeHostPath(path)
  const timeoutMs = hostPath === '/v1/computer/info'
    ? 15_000
    : hostPath.startsWith('/v1/computer/services') ? 60_000 : 330_000
  const deadline = AbortSignal.timeout(timeoutMs)
  return fetch(`${host.url}${hostPath}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.token}`,
      'content-type': 'application/json',
      accept: 'application/json, application/x-ndjson',
    },
    body: JSON.stringify({
      ...body,
      openlinkUserId: authorization.userId,
      openlinkProjectId: projectId,
      projectRef: authorization.platformProjectRef,
      expectedSubject: authorization.expectedSubject,
      accessToken: authorization.accessToken,
      scope: authorization.scope,
      expiresAt: authorization.expiresAt,
    }),
    cache: 'no-store',
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  })
}

/** Call the Cloud SDK Host with the current user's short-lived access token. */
export async function getCloudComputerInfo(projectId: string, requestedConnectionId?: string) {
  const response = await cloudComputerSdkRequest(projectId, '/v1/computer/info', {}, undefined, requestedConnectionId)
  if (!response.ok || response.status >= 300) {
    throw new CloudConnectionError(502, 'CLOUD_COMPUTER_UNAVAILABLE')
  }
  const result = await response.json().catch(() => null) as { computer?: unknown } | null
  if (!result?.computer || typeof result.computer !== 'object' || Array.isArray(result.computer)) {
    throw new CloudConnectionError(502, 'CLOUD_COMPUTER_UNAVAILABLE')
  }
  const computer = result.computer as Record<string, unknown>
  if (!uuid.test(String(computer.project)) || !['running', 'sleeping', 'unknown'].includes(String(computer.status))) {
    throw new CloudConnectionError(502, 'CLOUD_COMPUTER_UNAVAILABLE')
  }
  return {
    project: computer.project as string,
    status: computer.status as 'running' | 'sleeping' | 'unknown',
    plan: typeof computer.plan === 'string' ? computer.plan : null,
  }
}

export function isCloudChatSessionId(value: string) {
  return chatSessionId.test(value)
}
