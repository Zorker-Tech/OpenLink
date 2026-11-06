export type DesktopProfileKind = 'cloud' | 'remote'

export interface DesktopProfile {
  id: string
  kind: DesktopProfileKind
  name: string
  upstreamUrl: string
  gatewayPort: number | null
}

export interface DesktopState {
  profiles: DesktopProfile[]
  activeProfileId: string | null
  gateway: { origin: string; upstream?: string | null; setup?: boolean; dev?: boolean } | null
  platform: string
  versions: { electron: string; chrome: string; node: string }
}

export interface DesktopBridge {
  version: number
  getState(): Promise<DesktopState>
  listProfiles(): Promise<DesktopProfile[]>
  upsertProfile(profile: Partial<DesktopProfile> & { kind: DesktopProfileKind }): Promise<DesktopProfile>
  removeProfile(id: string): Promise<boolean>
  activateProfile(id: string): Promise<DesktopState>
  openExternal(url: string): Promise<boolean>
  auth: {
    hydite(input: {
      authorizationUrl: string
      redirectUri: string
      state: string
    }): Promise<{ code: string }>
  }
  onStateChanged(callback: (state: DesktopState) => void): () => void
  onOpenConnections(callback: () => void): () => void
}

declare global {
  interface Window {
    openLinkDesktop?: DesktopBridge
  }
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  return window.openLinkDesktop ?? null
}
