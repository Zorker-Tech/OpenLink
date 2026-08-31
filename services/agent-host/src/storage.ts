import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { AgentHostError } from './errors.js'

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface SessionStorageLayout {
  root: string
  workspace: string
  piSessions: string
  artifacts: string
  logs: string
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new AgentHostError('INVALID_PATH', `${label} contains unsafe path characters`)
  }
  return value
}

function pathApi(path: string) {
  if (path.startsWith('/')) return posix
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return win32
  return { isAbsolute, join, relative, resolve, sep }
}

export function resolveScopedPath(root: string, ...segments: string[]): string {
  return pathApi(root).resolve(root, ...segments)
}

export function assertContainedPath(root: string, candidate: string, label = 'path'): string {
  const api = pathApi(root)
  const resolvedRoot = api.resolve(root)
  const resolvedCandidate = api.resolve(candidate)
  const rel = api.relative(resolvedRoot, resolvedCandidate)
  if (rel === '..' || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel)) {
    throw new AgentHostError('INVALID_PATH', `${label} must remain inside ${resolvedRoot}`)
  }
  return resolvedCandidate
}

export function createSessionStorageLayout(
  baseRoot: string,
  userId: string,
  workspaceId: string,
  sessionId: string,
): SessionStorageLayout {
  const api = pathApi(baseRoot)
  const root = api.resolve(
    baseRoot,
    safeSegment(userId, 'userId'),
    safeSegment(workspaceId, 'workspaceId'),
    safeSegment(sessionId, 'sessionId'),
  )
  return {
    root,
    workspace: api.join(root, 'workspace'),
    piSessions: api.join(root, 'pi-sessions'),
    artifacts: api.join(root, 'artifacts'),
    logs: api.join(root, 'logs'),
  }
}

export async function ensureSessionStorage(layout: SessionStorageLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.workspace, { recursive: true, mode: 0o700 }),
    mkdir(layout.piSessions, { recursive: true, mode: 0o700 }),
    mkdir(layout.artifacts, { recursive: true, mode: 0o700 }),
    mkdir(layout.logs, { recursive: true, mode: 0o700 }),
  ])
}
