import 'server-only'

import { randomBytes } from 'node:crypto'
import { slugifyWorkspaceName, type OpenLinkWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

export type ProjectKind = 'code' | 'research'
export type ProjectSourceType = 'blank' | 'github'
export type ProjectStatus = 'active' | 'archived'

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
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface CreateProjectInput {
  name: string
  kind: ProjectKind
  sourceType: ProjectSourceType
  sourceUrl?: string | null
  description?: string
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

const PROJECT_SELECT = 'id, workspace_id, created_by, name, slug, kind, source_type, source_url, description, status, is_default, created_at, updated_at'

export async function ensureDraftProject(
  supabase: ServerSupabaseClient,
  userId: string,
  workspace: OpenLinkWorkspace,
): Promise<ProjectSummary> {
  const { data: existing, error: existingError } = await supabase
    .schema('openlink')
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('workspace_id', workspace.id)
    .eq('is_default', true)
    .maybeSingle()

  if (existingError) throw existingError
  if (existing) return existing as ProjectSummary

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
      description: '默认项目：未指定项目的聊天会话在此运行。',
      is_default: true,
    })
    .select(PROJECT_SELECT)
    .maybeSingle()

  if (!error && data) return data as ProjectSummary
  if (error?.code === '23505') {
    const { data: raced, error: racedError } = await supabase
      .schema('openlink')
      .from('projects')
      .select(PROJECT_SELECT)
      .eq('workspace_id', workspace.id)
      .eq('is_default', true)
      .single()
    if (racedError) throw racedError
    return raced as ProjectSummary
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

export async function listProjects(
  supabase: ServerSupabaseClient,
  workspaceId: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .eq('is_default', false)
    .order('updated_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as ProjectSummary[]
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
  return data as ProjectSummary | null
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

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0
      ? baseSlug
      : `${baseSlug.slice(0, 93)}-${randomBytes(3).toString('hex')}`
    const { data, error } = await supabase
      .schema('openlink')
      .from('projects')
      .insert({
        workspace_id: workspace.id,
        created_by: userId,
        name: input.name.trim(),
        slug,
        kind: input.kind,
        source_type: input.sourceType,
        source_url: sourceUrl,
        description: input.description?.trim() ?? '',
        is_default: false,
      })
      .select(PROJECT_SELECT)
      .single()

    if (!error) return data as ProjectSummary
    if (error.code !== '23505') throw error
  }

  throw new Error('PROJECT_SLUG_CONFLICT')
}
