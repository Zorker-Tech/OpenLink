import 'server-only'

import type { User } from '@supabase/supabase-js'
import { createClient } from '@/utils/supabase/server'

export interface OpenLinkProfile {
  user_id: string
  nickname: string | null
  nickname_confirmed: boolean
  organization_onboarding_completed: boolean
}

export interface OpenLinkWorkspace {
  id: string
  owner_id: string | null
  organization_id: string | null
  name: string
  slug: string
  scope_type: 'personal' | 'organization'
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

const metadataNicknameKeys = ['user_name', 'preferred_username', 'name', 'full_name'] as const

export function getMetadataNickname(user: User) {
  for (const key of metadataNicknameKeys) {
    const value = user.user_metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 64)
  }

  return null
}

export function getDefaultNickname(user: User) {
  return getMetadataNickname(user) ?? user.email?.split('@')[0]?.trim().slice(0, 64) ?? 'OpenLink User'
}

export function getAvatarUrl(user: User) {
  const value = user.user_metadata?.avatar_url ?? user.user_metadata?.picture
  return typeof value === 'string' && value ? value : null
}

export function slugifyWorkspaceName(name: string, fallbackId: string) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

  return slug || `workspace-${fallbackId.slice(0, 8)}`
}

export async function getOwnedWorkspace(
  supabase: ServerSupabaseClient,
  userId: string,
  slug?: string,
) {
  let query = supabase
    .schema('openlink')
    .from('workspaces')
    .select('id, owner_id, organization_id, name, slug, scope_type')
    .eq('owner_id', userId)
    .eq('scope_type', 'personal')

  if (slug) query = query.eq('slug', slug)

  const { data, error } = await query.order('created_at', { ascending: true }).limit(1).maybeSingle()
  if (error) throw error
  return data as OpenLinkWorkspace | null
}

export async function getAccessibleWorkspace(
  supabase: ServerSupabaseClient,
  slug: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('workspaces')
    .select('id, owner_id, organization_id, name, slug, scope_type')
    .eq('slug', slug)
    .maybeSingle()

  if (error) throw error
  return data as OpenLinkWorkspace | null
}

export async function getAccessibleWorkspaceById(
  supabase: ServerSupabaseClient,
  id: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('workspaces')
    .select('id, owner_id, organization_id, name, slug, scope_type')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data as OpenLinkWorkspace | null
}

export async function ensureWorkspace(
  supabase: ServerSupabaseClient,
  user: User,
  nickname: string,
) {
  const existing = await getOwnedWorkspace(supabase, user.id)
  if (existing) return existing

  const baseSlug = slugifyWorkspaceName(nickname, user.id)
  const candidates = [baseSlug, `${baseSlug}-${user.id.slice(0, 8)}`]

  for (const slug of candidates) {
    const { data, error } = await supabase
      .schema('openlink')
      .from('workspaces')
      .insert({
        owner_id: user.id,
        organization_id: null,
        scope_type: 'personal',
        name: nickname,
        slug,
      })
      .select('id, owner_id, organization_id, name, slug, scope_type')
      .single()

    if (!error) return data as OpenLinkWorkspace
    if (error.code !== '23505') throw error

    const racedWorkspace = await getOwnedWorkspace(supabase, user.id)
    if (racedWorkspace) return racedWorkspace
  }

  throw new Error('Unable to create a unique workspace URL.')
}

export async function resolveAppEntry(supabase: ServerSupabaseClient, user: User) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('user_id, nickname, nickname_confirmed, organization_onboarding_completed')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) throw error

  let profile = data as OpenLinkProfile | null
  const metadataNickname = getMetadataNickname(user)

  if (!profile) {
    const nickname = getDefaultNickname(user)
    const { data: inserted, error: insertError } = await supabase
      .schema('openlink')
      .from('profiles')
      .insert({
        user_id: user.id,
        nickname,
        nickname_confirmed: Boolean(metadataNickname),
        organization_onboarding_completed: false,
      })
      .select('user_id, nickname, nickname_confirmed, organization_onboarding_completed')
      .single()

    if (insertError) {
      // React Server Components can resolve the same entry route concurrently
      // (for example, a navigation request racing a router prefetch). Both
      // requests may observe a missing profile before either insert commits.
      // The primary key is the user id, so the losing insert must reuse the
      // profile created by the winning request instead of turning a harmless
      // bootstrap race into a 500 page.
      if (insertError.code !== '23505') throw insertError

      const { data: racedProfile, error: racedProfileError } = await supabase
        .schema('openlink')
        .from('profiles')
        .select('user_id, nickname, nickname_confirmed, organization_onboarding_completed')
        .eq('user_id', user.id)
        .single()

      if (racedProfileError) throw racedProfileError
      profile = racedProfile as OpenLinkProfile
    } else {
      profile = inserted as OpenLinkProfile
    }
  }

  if (!profile.nickname_confirmed || !profile.nickname) {
    return {
      needsOnboarding: true as const,
      defaultNickname: profile.nickname ?? getDefaultNickname(user),
      needsOrganizationOnboarding: false as const,
      workspace: null,
    }
  }

  const workspace = await ensureWorkspace(supabase, user, profile.nickname)

  if (!profile.organization_onboarding_completed) {
    return {
      needsOnboarding: false as const,
      needsOrganizationOnboarding: true as const,
      defaultNickname: profile.nickname,
      workspace,
    }
  }

  return {
    needsOnboarding: false as const,
    needsOrganizationOnboarding: false as const,
    defaultNickname: profile.nickname,
    workspace,
  }
}

export async function confirmNickname(
  supabase: ServerSupabaseClient,
  user: User,
  nickname: string,
) {
  const normalizedNickname = nickname.trim()
  const { error } = await supabase
    .schema('openlink')
    .from('profiles')
    .upsert({
      user_id: user.id,
      nickname: normalizedNickname,
      nickname_confirmed: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (error) throw error
  return ensureWorkspace(supabase, user, normalizedNickname)
}

export async function completeOrganizationOnboarding(
  supabase: ServerSupabaseClient,
  userId: string,
) {
  const { error } = await supabase
    .schema('openlink')
    .from('profiles')
    .update({
      organization_onboarding_completed: true,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)

  if (error) throw error
}
