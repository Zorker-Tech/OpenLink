import type { AgentPolicy } from './contracts.js'
import { AgentHostError } from './errors.js'
import { assertContainedPath, resolveScopedPath } from './storage.js'

export interface CompiledSandboxPolicy {
  filesystem: {
    denyRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowUnixSockets: string[]
  }
}

const DEFAULT_DENY_WRITE = ['.env', '.env.*', '.git/config', '.git/credentials']
const DEFAULT_DENY_READ = ['~/.ssh', '~/.aws', '~/.config/gcloud', '~/.config/gh']

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function validateDomain(value: string, field: string): string {
  const domain = value.trim()
  if (!domain || /[\s\u0000-\u001f]/.test(domain) || domain.includes('/')) {
    throw new AgentHostError('INVALID_POLICY', `${field} contains an invalid domain`)
  }
  return domain
}

export function compileSandboxPolicy(
  workspaceRoot: string,
  storageRoot: string,
  policy: AgentPolicy,
): CompiledSandboxPolicy {
  const workspace = resolveScopedPath(workspaceRoot)
  const storage = resolveScopedPath(storageRoot)
  const writeRoots = policy.allowWrite.length > 0 ? policy.allowWrite : [workspace, storage]

  for (const path of writeRoots) {
    try {
      assertContainedPath(workspace, path, 'allowWrite')
    } catch {
      assertContainedPath(storage, path, 'allowWrite')
    }
  }

  const denyWrite = unique([...DEFAULT_DENY_WRITE, ...policy.denyWrite])
  const denyRead = unique([...DEFAULT_DENY_READ, ...policy.denyRead])
  const allowedDomains = unique(policy.allowedDomains.map((value) => validateDomain(value, 'allowedDomains')))
  const deniedDomains = unique(policy.deniedDomains.map((value) => validateDomain(value, 'deniedDomains')))

  return {
    filesystem: {
      denyRead,
      allowWrite: writeRoots.map((path) => resolveScopedPath(path)),
      denyWrite,
    },
    network: {
      allowedDomains,
      deniedDomains,
      allowUnixSockets: [...policy.allowUnixSockets],
    },
  }
}
