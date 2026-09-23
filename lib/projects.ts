import 'server-only'

import { randomBytes, randomUUID } from 'node:crypto'
import { encryptProjectSshPrivateKey } from '@/lib/project-ssh-secrets.server'
import { getT } from '@/lib/i18n/server'
import { slugifyWorkspaceName, type OpenLinkWorkspace } from '@/lib/workspaces'
import type { AgentKind } from '@/lib/chat-session-types'
import { createClient } from '@/utils/supabase/server'

export type ProjectKind = 'code' | 'research'
export type ProjectSourceType = 'blank' | 'github'
export type ProjectStatus = 'waiting' | 'active' | 'archived'
export type ProjectRuntimeStatus = 'provisioning' | 'ready' | 'stopped' | 'error' | 'deleting'
export type ProjectRuntimeProvisioningPhase = 'queued' | 'claimed' | 'starting_vm' | 'configuring_runtime'
  | 'starting_project_database' | 'starting_agent_services' | 'connecting_services'
  | 'retry_wait' | 'ready' | 'stopped' | 'deleting' | 'failed'
export type ProjectDiskMode = 'thin' | 'thick'
export type ProjectExecutionMode = 'local' | 'ssh'

export interface ProjectSshTarget {
  host: string
  port: number
  user: string
  remoteRoot: string
  privateKey: string
  /** Pinned OpenSSH known_hosts entry for this target. */
  knownHosts: string
}

export interface ProjectSummary {
  id: string
  workspace_id: string
  created_by: string
  name: string
  slug: string
  kind: ProjectKind
  source_type: ProjectSourceType
  source_url: string | null
  description: string
  status: ProjectStatus
  runtime_status: ProjectRuntimeStatus | null
  runtime_error: string | null
  runtime_phase: ProjectRuntimeProvisioningPhase | null
  runtime_phase_updated_at: string | null
  runtime_provisioning_attempts: number
  runtime_provisioning_next_attempt_at: string | null
  runtime_provisioning_lease_expires_at: string | null
  runtime_claimed: boolean
  is_default: boolean
  default_agent?: AgentKind
  disk_mode: ProjectDiskMode
  execution_mode: ProjectExecutionMode
  ssh_host: string | null
  ssh_port: number | null
  ssh_user: string | null
  ssh_remote_root: string | null
  ssh_known_hosts: string | null
  ssh_private_key_hint: string | null
  created_at: string
  updated_at: string
}

export interface CreateProjectInput {
  name: string
  kind: ProjectKind
  sourceType: ProjectSourceType
  sourceUrl?: string | null
  description?: string
  diskMode: ProjectDiskMode
  executionMode: ProjectExecutionMode
  defaultAgent?: AgentKind
  sshTarget?: ProjectSshTarget
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

// disk-mode governance adds a composite FK in addition to the canonical
// project_id relationship. Name the one-to-one FK explicitly so PostgREST
// never has to guess which embedding path represents runtime projection.
const PROJECT_SELECT = 'id, workspace_id, created_by, name, slug, kind, source_type, source_url, description, status, is_default, default_agent, disk_mode, execution_mode, ssh_host, ssh_port, ssh_user, ssh_remote_root, ssh_known_hosts, ssh_private_key_hint, created_at, updated_at, project_runtimes:project_runtimes!project_runtimes_project_id_fkey(status, last_error, provisioning_phase, provisioning_phase_updated_at, provisioning_attempts, provisioning_next_attempt_at, provisioning_lease_expires_at, provisioning_claimed_by)'

function projectSummary(row: Record<string, unknown>): ProjectSummary {
  const relation = row.project_runtimes
  const runtime = (Array.isArray(relation) ? relation[0] : relation) as Record<string, unknown> | null | undefined
  const { project_runtimes: _projectRuntimes, ...project } = row
  return {
    ...project,
    runtime_status: typeof runtime?.status === 'string' ? runtime.status as ProjectRuntimeStatus : null,
    runtime_error: typeof runtime?.last_error === 'string' ? runtime.last_error : null,
    runtime_phase: typeof runtime?.provisioning_phase === 'string' ? runtime.provisioning_phase as ProjectRuntimeProvisioningPhase : null,
    runtime_phase_updated_at: typeof runtime?.provisioning_phase_updated_at === 'string' ? runtime.provisioning_phase_updated_at : null,
    runtime_provisioning_attempts: typeof runtime?.provisioning_attempts === 'number' ? runtime.provisioning_attempts : 0,
    runtime_provisioning_next_attempt_at: typeof runtime?.provisioning_next_attempt_at === 'string' ? runtime.provisioning_next_attempt_at : null,
    runtime_provisioning_lease_expires_at: typeof runtime?.provisioning_lease_expires_at === 'string' ? runtime.provisioning_lease_expires_at : null,
    runtime_claimed: typeof runtime?.provisioning_claimed_by === 'string' && runtime.provisioning_claimed_by.length > 0,
  } as ProjectSummary
}

export async function ensureDraftProject(
  supabase: ServerSupabaseClient,
  userId: string,
  workspace: OpenLinkWorkspace,
): Promise<ProjectSummary> {
  const { t } = await getT()
  const { data: existing, error: existingError } = await supabase
    .schema('openlink')
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('workspace_id', workspace.id)
    .eq('is_default', true)
    .maybeSingle()

  if (existingError) throw existingError
  if (existing) return projectSummary(existing as Record<string, unknown>)

  const { data, error } = await supabase
    .schema('openlink')
    .from('projects')
    .insert({
      workspace_id: workspace.id,
      created_by: userId,
      name: 'Draft',
      slug: 'draft',
      kind: 'code',
      source_type: 'blank',
      source_url: null,
      description: t('默认项目：未指定项目的聊天会话在此运行。'),
        is_default: true,
        default_agent: 'codex',
        disk_mode: 'thin',
        execution_mode: 'local',
    })
    .select(PROJECT_SELECT)
    .maybeSingle()

  if (!error && data) return projectSummary(data as Record<string, unknown>)
  if (error?.code === '23505') {
    const { data: raced, error: racedError } = await supabase
      .schema('openlink')
      .from('projects')
      .select(PROJECT_SELECT)
      .eq('workspace_id', workspace.id)
      .eq('is_default', true)
      .single()
    if (racedError) throw racedError
    return projectSummary(raced as Record<string, unknown>)
  }
  throw error ?? new Error('DRAFT_PROJECT_CREATE_FAILED')
}

export function normalizeGitHubUrl(value: string) {
  try {
    const url = new URL(value.trim())
    const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || segments.length !== 2) return null
    return `https://github.com/${segments[0]}/${segments[1]}`
  } catch {
    return null
  }
}

function normalizeSshTarget(input: ProjectSshTarget | undefined): ProjectSshTarget | null {
  if (!input) return null
  const host = input.host.trim()
  const user = input.user.trim()
  const remoteRoot = input.remoteRoot.trim().replace(/\/+$/, '') || '/'
  const privateKey = input.privateKey.trim()
  const knownHosts = input.knownHosts.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,253}$/.test(host) || host.startsWith('-')) return null
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) return null
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)) return null
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(remoteRoot) || remoteRoot.includes('..')) return null
  if (privateKey.length < 64 || privateKey.length > 32_768 || !privateKey.includes('PRIVATE KEY')) return null
  // A user-pinned known_hosts entry prevents a first-connect MITM from
  // becoming trusted configuration.  It is public key material, not a secret.
  if (knownHosts.length < 32 || knownHosts.length > 16_384 || /[\u0000\r]/.test(knownHosts)) return null
  if (!knownHosts.split('\n').every((line) => !line.trim() || /^(?:\[[^\]]+\]|[A-Za-z0-9._:-]+|\|1\|)[^\n]*\s+(?:ssh-|ecdsa-|sk-)/.test(line.trim()))) return null
  return { host, port: input.port, user, remoteRoot, privateKey, knownHosts }
}

export async function listProjects(
  supabase: ServerSupabaseClient,
  workspaceId: string,
): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .schema('openlink')
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    .eq('is_default', false)
    .order('updated_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map((row: unknown) => projectSummary(row as Record<string, unknown>))
}

export async function getDefaultProject(
  supabase: ServerSupabaseClient,
  workspaceId: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('is_default', true)
    .maybeSingle()

  if (error) throw error
  return data ? projectSummary(data as Record<string, unknown>) : null
}

export async function getProject(
  supabase: ServerSupabaseClient,
  projectId: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('id', projectId)
    .maybeSingle()

  if (error) throw error
  return data ? projectSummary(data as Record<string, unknown>) : null
}

export async function createProject(
  supabase: ServerSupabaseClient,
  userId: string,
  workspace: OpenLinkWorkspace,
  input: CreateProjectInput,
) {
  const baseSlug = slugifyWorkspaceName(input.name, userId)
  const sourceUrl = input.sourceType === 'github'
    ? normalizeGitHubUrl(input.sourceUrl ?? '')
    : null

 if (input.sourceType === 'github' && !sourceUrl) {
   throw new Error('INVALID_GITHUB_URL')
 }
  if (input.executionMode !== 'local' && input.executionMode !== 'ssh') {
    throw new Error('INVALID_EXECUTION_MODE')
  }
  const sshTarget = input.executionMode === 'ssh' ? normalizeSshTarget(input.sshTarget) : null
  if (input.executionMode === 'ssh' && !sshTarget) throw new Error('INVALID_SSH_TARGET')

 for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomUUID()
   const slug = attempt === 0
     ? baseSlug
     : `${baseSlug.slice(0, 93)}-${randomBytes(3).toString('hex')}`
    const encryptedSshKey = sshTarget
      ? encryptProjectSshPrivateKey(sshTarget.privateKey, userId, id)
      : null
   const { data, error } = await supabase
     .schema('openlink')
     .from('projects')
     .insert({
        id,
        workspace_id: workspace.id,
        created_by: userId,
        name: input.name.trim(),
        slug,
        kind: input.kind,
        source_type: input.sourceType,
        source_url: sourceUrl,
        description: input.description?.trim() ?? '',
        status: 'waiting',
        is_default: false,
        default_agent: input.defaultAgent ?? 'codex',
        disk_mode: input.diskMode,
        execution_mode: input.executionMode,
        ...(sshTarget && encryptedSshKey ? {
          ssh_host: sshTarget.host,
          ssh_port: sshTarget.port,
          ssh_user: sshTarget.user,
          ssh_remote_root: sshTarget.remoteRoot,
          ssh_known_hosts: sshTarget.knownHosts,
          ssh_encrypted_private_key: encryptedSshKey.ciphertext,
          ssh_private_key_iv: encryptedSshKey.iv,
          ssh_private_key_tag: encryptedSshKey.tag,
          ssh_private_key_hint: encryptedSshKey.hint,
          ssh_encryption_version: encryptedSshKey.version,
        } : {}),
     })
      .select(PROJECT_SELECT)
      .single()

    if (!error) return projectSummary(data as Record<string, unknown>)
    if (error.code !== '23505') throw error
  }

  throw new Error('PROJECT_SLUG_CONFLICT')
}
