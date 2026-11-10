export interface VncProxyDescriptor {
  primaryUrl: string
  forkBaseUrl: string
  networkToken: string
}

export interface ForeverBoxWindowStatus {
  vncUrl: string
  [key: string]: unknown
}

export interface ForeverBoxStatus {
  vncUrl?: string | null
  windows?: ForeverBoxWindowStatus[] | null
  [key: string]: unknown
}
