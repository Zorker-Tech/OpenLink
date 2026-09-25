/**
 * The plugin logos a marketplace has shown.
 *
 * A logo is fetched from wherever the plugin's author put it, and the platform keeps the ones it has seen so a later
 * render can tell a logo it already knows from one it has never seen.
 */
const knownLogoUrls = new Set<string>();
export function rememberPluginLogoUrl(url: string): void { knownLogoUrls.add(url); }
export function isKnownPluginLogoUrl(url: string): boolean { return knownLogoUrls.has(url); }
