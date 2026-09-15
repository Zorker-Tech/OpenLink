import { PlatformProductSdk } from '@vtslx/platform-sdk/product'
import type { OAuthTokenStore, OAuthRefreshCoordinator } from '@vtslx/platform-sdk/auth'

export interface AuthorizedCloudProjectBinding {
  openlinkUserId: string
  openlinkProjectId: string
  platformProjectRef: string
}

export interface OpenLinkCloudSdkOptions {
  mode: 'local' | 'cloud'
  openlinkUserId: string
  hyditeSubject: string
  clientId: string
  redirectUri: string
  /** Must be bound to this user's cloud connection; never reuse a global store. */
  tokenStore: OAuthTokenStore
  refreshCoordinator: OAuthRefreshCoordinator
  fetch?: typeof globalThis.fetch
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Cloud-only client composition. ZOKERBASE remains the application identity/data owner. */
export function createOpenLinkCloudSdk(options: OpenLinkCloudSdkOptions) {
  if (options.mode !== 'cloud') throw new Error('Cloud SDK is unavailable in Local mode')
  if (!uuid.test(options.openlinkUserId) || !options.hyditeSubject || options.hyditeSubject.length > 255)
    throw new Error('A verified application-to-cloud identity binding is required')
  if (!options.tokenStore || !['load', 'save', 'clear'].every(name => typeof options.tokenStore[name as keyof OAuthTokenStore] === 'function'))
    throw new Error('An isolated cloud token store is required')
  if (typeof options.refreshCoordinator?.runExclusive !== 'function')
    throw new Error('A durable Cloud refresh coordinator is required')
  const sdk = new PlatformProductSdk({
    auth: {
      issuer: 'https://auth.hydite.com', clientId: options.clientId,
      redirectUri: options.redirectUri, tokenStore: options.tokenStore,
      refreshCoordinator: options.refreshCoordinator,
      scopes: ['openid', 'profile', 'email', 'computer:read', 'computer:write'],
    },
    apiBaseUrls: ['https://auth.hydite.com'],
    workspaceOrigins: ['wss://openlink-workspaces.sumeimeitiansidunfan.workers.dev'],
    fetch: options.fetch,
  })
  async function verifyIdentity() {
    return sdk.auth.userInfo({ expectedSubject: options.hyditeSubject })
  }
  async function projectRef(binding: AuthorizedCloudProjectBinding) {
    if (binding.openlinkUserId !== options.openlinkUserId || !uuid.test(binding.openlinkProjectId) || !uuid.test(binding.platformProjectRef))
      throw new Error('Cloud project binding does not match this application user')
    await verifyIdentity()
    return binding.platformProjectRef
  }
  return {
    auth: sdk.auth,
    verifyIdentity,
    async listProjects() { await verifyIdentity(); return sdk.directory.listProjects() },
    async project(binding: AuthorizedCloudProjectBinding) { return sdk.project(await projectRef(binding)) },
    async workspace(binding: AuthorizedCloudProjectBinding) { return sdk.workspace(await projectRef(binding)) },
  }
}
