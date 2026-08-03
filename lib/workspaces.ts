import 'server-only'

import type { User } from '@supabase/supabase-js'
import { createClient } from '@/utils/supabase/server'

export interface OpenLinkProfile {
  user_id: string
  nickname: string | null
  nickname_confirmed: boolean
}

export interface OpenLinkWorkspace {
  id: string
  owner_id: string
  name: string
  slug: string
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

function slugifyWorkspaceName(name: string, userId: string) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

  return slug || `workspace-${userId.slice(0, 8)}`
}

export async function getOwnedWorkspace(
  supabase: ServerSupabaseClient,
  userId: string,
  slug?: string,
) {
  let query = supabase
    .schema('openlink')
    .from('workspaces')
    .select('id, owner_id, name, slug')
    .eq('owner_id', userId)

  if (slug) query = query.eq('slug', slug)

  const { data, error } = await query.order('created_at', { ascending: true }).limit(1).maybeSingle()
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
      .insert({ owner_id: user.id, name: nickname, slug })
      .select('id, owner_id, name, slug')
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
    .select('user_id, nickname, nickname_confirmed')
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
      })
      .select('user_id, nickname, nickname_confirmed')
      .single()

    if (insertError) throw insertError
    profile = inserted as OpenLinkProfile
  }

  if (!profile.nickname_confirmed || !profile.nickname) {
    return {
      needsOnboarding: true as const,
      defaultNickname: profile.nickname ?? getDefaultNickname(user),
      workspace: null,
    }
  }

  const workspace = await ensureWorkspace(supabase, user, profile.nickname)

  return {
    needsOnboarding: false as const,
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
