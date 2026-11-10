/** Addresses shown by marketplace listings, kept so image reads can reject unseen locations. */
const shownLogoSources = new Set<string>();

/** Marks a catalog logo address as user-visible. */
export function rememberMarketplaceLogoSource(url: string): void {
  shownLogoSources.add(url);
}

/** Whether a catalog has already shown this address. */
export function isMarketplaceLogoSourceKnown(url: string): boolean {
  return shownLogoSources.has(url);
}
