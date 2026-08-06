import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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

export function assertContainedPath(root: string, candidate: string, label = 'path'): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const rel = relative(resolvedRoot, resolvedCandidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
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
  const root = resolve(
    baseRoot,
    safeSegment(userId, 'userId'),
    safeSegment(workspaceId, 'workspaceId'),
    safeSegment(sessionId, 'sessionId'),
  )
  return {
    root,
    workspace: join(root, 'workspace'),
    piSessions: join(root, 'pi-sessions'),
    artifacts: join(root, 'artifacts'),
    logs: join(root, 'logs'),
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
