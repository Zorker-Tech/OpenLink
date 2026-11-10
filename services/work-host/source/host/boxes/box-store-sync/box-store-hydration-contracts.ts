export interface HydrationEvidence {
  readonly failures?: readonly unknown[]
  readonly manifestEntries?: number
  readonly files?: number
  readonly verified?: number
  readonly hydrateSource?: string
  readonly authoritativeStoreDbEntries?: number
  readonly restoredStoreDbEntries?: number
}
