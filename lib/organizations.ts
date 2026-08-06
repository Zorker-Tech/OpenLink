import 'server-only'

import { slugifyWorkspaceName } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

export type OrganizationRole = 'owner' | 'admin' | 'member'

export interface OrganizationSummary {
  id: string
  name: string
  slug: string
  role: OrganizationRole
  workspaceSlug: string
}

interface OrganizationRpcResult {
  organization_id: string
  organization_name: string
  organization_slug: string
  workspace_id: string
  workspace_slug: string
  member_role: OrganizationRole
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

export async function listOrganizations(
  supabase: ServerSupabaseClient,
  userId: string,
) {
  const { data: memberships, error: membershipError } = await supabase
    .schema('openlink')
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', userId)

  if (membershipError) throw membershipError
  if (!memberships?.length) return [] as OrganizationSummary[]

  const organizationIds = memberships.map((membership) => membership.organization_id)
  const [{ data: organizations, error: organizationError }, { data: workspaces, error: workspaceError }] = await Promise.all([
    supabase
      .schema('openlink')
      .from('organizations')
      .select('id, name, slug')
      .in('id', organizationIds),
    supabase
      .schema('openlink')
      .from('workspaces')
      .select('organization_id, slug')
      .in('organization_id', organizationIds),
  ])

  if (organizationError) throw organizationError
  if (workspaceError) throw workspaceError

  const membershipByOrganization = new Map(
    memberships.map((membership) => [membership.organization_id, membership.role as OrganizationRole]),
  )
  const workspaceByOrganization = new Map(
    (workspaces ?? []).map((workspace) => [workspace.organization_id, workspace.slug]),
  )

  return (organizations ?? [])
    .map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: membershipByOrganization.get(organization.id) ?? 'member',
      workspaceSlug: workspaceByOrganization.get(organization.id) ?? organization.slug,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function createOrganization(
  supabase: ServerSupabaseClient,
  name: string,
  fallbackId: string,
) {
  const baseSlug = slugifyWorkspaceName(name, fallbackId)
  const candidates = [baseSlug, `${baseSlug}-${fallbackId.slice(0, 8)}`]

  for (const slug of candidates) {
    const { data, error } = await supabase
      .schema('openlink')
      .rpc('create_organization', { p_name: name.trim(), p_slug: slug })

    if (!error) return (data?.[0] ?? null) as OrganizationRpcResult | null
    if (error.code !== '23505') throw error
  }

  throw new Error('ORGANIZATION_SLUG_CONFLICT')
}

export async function joinOrganization(
  supabase: ServerSupabaseClient,
  code: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .rpc('join_organization', { p_code: code.trim() })

  if (error) throw error
  return (data?.[0] ?? null) as OrganizationRpcResult | null
}
