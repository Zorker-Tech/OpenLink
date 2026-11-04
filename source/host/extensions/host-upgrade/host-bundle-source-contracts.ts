export class SlateHostBundleSourceError extends Error {}

export interface HostBundleSource {
  readonly version: string
  loadBundleBytes(): Promise<Uint8Array>
}
