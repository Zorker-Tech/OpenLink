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

export interface DesktopCapabilities {
  apiVersion: number
  serverVersion: string
  minDesktopVersion: string
  runtimeMode: 'local' | 'cloud'
  features: string[]
  auth: string[]
  publicConfig: DesktopPublicConfig
}

export class DesktopApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DesktopApiError'
  }
}

export class DesktopRedirect extends Error {
  constructor(readonly path: string) {
    super(`Desktop redirect: ${path}`)
    this.name = 'DesktopRedirect'
  }
}

function setMeta(name: string, content: string) {
  let element = document.querySelector(`meta[name="${name}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute('name', name)
    document.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

/**
 * The shared Supabase browser client reads runtime configuration from meta
 * tags before falling back to build-time environment values. Installing the
 * tags from the server capability response keeps a single desktop build usable
 * against local, Cloud, and remote instances without rebuilding.
 */
export function installRuntimeMeta(config: DesktopPublicConfig) {
  setMeta('openlink-runtime-mode', config.runtimeMode)
  setMeta('openlink-supabase-url', config.supabaseUrl)
  setMeta('openlink-supabase-publishable-key', config.supabasePublishableKey)
  document.documentElement.dataset.runtimeMode = config.runtimeMode
}

export async function fetchCapabilities(): Promise<DesktopCapabilities> {
  const response = await fetch('/api/desktop/v1/capabilities', {
    cache: 'no-store',
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new DesktopApiError(
      response.status,
      'CAPABILITIES_UNAVAILABLE',
      'Desktop capabilities are unavailable',
    )
  }
  const payload = (await response.json()) as Partial<DesktopCapabilities>
  if (
    typeof payload.apiVersion !== 'number' ||
    typeof payload.runtimeMode !== 'string' ||
    !payload.publicConfig ||
    typeof payload.publicConfig.supabaseUrl !== 'string'
  ) {
    throw new DesktopApiError(502, 'CAPABILITIES_INVALID', 'Desktop capabilities are invalid')
  }
  return payload as DesktopCapabilities
}

function apiPayload(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
}

export async function desktopBootstrap(
  path: string,
  search?: URLSearchParams,
): Promise<Record<string, unknown>> {
  const query = search?.toString()
  const response = await fetch(
    `/api/desktop/v1/bootstrap/${path}${query ? `?${query}` : ''}`,
    {
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    },
  )
  const payload = apiPayload(await response.json().catch(() => null))
  const redirect = payload?.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/')) {
    throw new DesktopRedirect(redirect)
  }
  if (!response.ok) {
    const error = apiPayload(payload?.error)
    throw new DesktopApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'BOOTSTRAP_FAILED',
      typeof error?.message === 'string' ? error.message : 'Desktop bootstrap failed',
    )
  }
  return payload ?? {}
}

export async function callDesktopAction<T>(
  action: string,
  input?: unknown,
): Promise<T> {
  const response = await fetch('/api/desktop/v1/actions', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, input }),
  })
  const payload = apiPayload(await response.json().catch(() => null))
  const redirect = payload?.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/')) {
    const { navigateDesktop } = await import('./navigation-runtime')
    navigateDesktop(redirect)
    return null as T
  }
  if (!response.ok || payload?.ok === false) {
    const error = apiPayload(payload?.error)
    throw new DesktopApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'ACTION_FAILED',
      typeof error?.message === 'string' ? error.message : 'Desktop action failed',
    )
  }
  return payload?.result as T
}
