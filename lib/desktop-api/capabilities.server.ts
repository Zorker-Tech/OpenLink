import 'server-only'

import { getRuntimeMode } from '@/lib/runtime-mode.server'

/**
 * Version of the Desktop API contract exposed under `/api/desktop/v1`.
 *
 * The desktop renderer is an independent client: it may be older or newer than
 * the server it connects to. Every endpoint in this namespace is additive
 * within a major version. A breaking change requires `/api/desktop/v2` and a
 * compatibility window for v1.
 */
export const DESKTOP_API_VERSION = 1

/** Oldest desktop build that can still consume this API version. */
export const DESKTOP_MIN_CLIENT_VERSION = '0.1.0'

export const DESKTOP_FEATURES = [
  'bootstrap.home',
  'bootstrap.app-entry',
  'bootstrap.workspace',
  'bootstrap.projects',
  'bootstrap.knowledge',
  'bootstrap.chat',
  'bootstrap.chat-data',
  'bootstrap.settings',
  'bootstrap.settings.providers',
  'bootstrap.settings.provider',
  'bootstrap.settings.embeddings',
  'bootstrap.settings.embedding-provider',
  'bootstrap.settings.skills',
  'bootstrap.settings.skill',
  'bootstrap.onboarding',
  'actions.chat',
  'actions.projects',
  'actions.organizations',
  'actions.settings',
  'actions.skills',
  'actions.onboarding',
  'auth.email-password',
  'auth.hydite',
] as const

export type DesktopFeature = (typeof DESKTOP_FEATURES)[number]

export interface DesktopHyditeConfig {
  issuer: string
  clientId: string | null
  scopes: string[]
  redirectUri: string
}

export interface DesktopPublicConfig {
  runtimeMode: 'local' | 'cloud'
  supabaseUrl: string
  supabasePublishableKey: string
  zorkerAppUrl: string | null
  hydite: DesktopHyditeConfig | null
}

const HYDITE_ISSUER = 'https://auth.hydite.com'
const HYDITE_SCOPES = ['openid', 'profile', 'email']

export function desktopHyditeRedirectUri() {
  const port = Number(process.env.OPENLINK_DESKTOP_AUTH_PORT || 43127)
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 43127}/auth/hydite/callback`
}

function publicSupabaseConfig(): Pick<DesktopPublicConfig, 'supabaseUrl' | 'supabasePublishableKey'> {
  // Static preview builds intentionally carry no backend. The desktop must get
  // the same placeholder values the web layout renders.
  if (process.env.OPENLINK_STATIC_UI === '1') {
    return {
      supabaseUrl: 'http://127.0.0.1:0',
      supabasePublishableKey: 'static-ui-preview-no-backend',
    }
  }

  const local = getRuntimeMode() === 'local'
  const supabaseUrl = local
    ? process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
    : process.env.OPENLINK_CLOUD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabasePublishableKey = local
    ? process.env.OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY || process.env.OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY
    : process.env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  return {
    supabaseUrl: supabaseUrl?.trim() ?? '',
    supabasePublishableKey: supabasePublishableKey?.trim() ?? '',
  }
}

export function desktopPublicConfig(): DesktopPublicConfig {
  const runtimeMode = getRuntimeMode()
  return {
    runtimeMode,
    ...publicSupabaseConfig(),
    zorkerAppUrl: process.env.NEXT_PUBLIC_ZORKER_APP_URL?.trim() || null,
    // Cloud identity is a public OAuth client. The desktop may register its
    // loopback redirect dynamically; a configured client id is the fallback
    // for issuers that do not expose dynamic registration.
    hydite:
      runtimeMode === 'cloud'
        ? {
            issuer: HYDITE_ISSUER,
            clientId: process.env.OPENLINK_CLOUD_OAUTH_CLIENT_ID?.trim() || null,
            scopes: [...HYDITE_SCOPES],
            redirectUri: desktopHyditeRedirectUri(),
          }
        : null,
  }
}

export function desktopCapabilities() {
  const runtimeMode = getRuntimeMode()
  return {
    apiVersion: DESKTOP_API_VERSION,
    serverVersion:
      process.env.OPENLINK_RELEASE_ID?.trim() ||
      process.env.OPENLINK_VERSION?.trim() ||
      'development',
    minDesktopVersion: DESKTOP_MIN_CLIENT_VERSION,
    runtimeMode,
    features: [...DESKTOP_FEATURES],
    auth: runtimeMode === 'cloud' ? ['hydite'] : ['email-password'],
    publicConfig: desktopPublicConfig(),
  }
}
