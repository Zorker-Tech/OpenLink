/**
 * The plugin logos a marketplace has shown.
 *
 * A logo is fetched from wherever the plugin's author put it, and the platform keeps the ones it has seen so a later
 * render can tell a logo it already knows from one it has never seen.
 */

/** The addresses a plugin logo has been shown from. */
const knownLogoUrls = new Set<string>();

/** Remember that a plugin's logo lives at this address, so a later render knows it has been shown. */
export const rememberPluginLogoUrl = (url: string): void => {
  knownLogoUrls.add(url);
};

/** Whether this address is one the marketplace has already shown. */
export const isKnownPluginLogoUrl = (url: string): boolean => knownLogoUrls.has(url);
