/**
 * The desktop's own preferences, and how a plugin is opened in it.
 *
 * The theme is one of three choices with a default, and a plugin is opened through the desktop's own URL scheme with
 * the plugin's id in it — the id is checked before it is put into a link, since a link is handed to the operating
 * system.
 */
export const SLATE_THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type SlateThemePreference = (typeof SLATE_THEME_PREFERENCES)[number];
export const DEFAULT_SLATE_THEME_PREFERENCE: SlateThemePreference = "system";
export function isSlateThemePreference(value: unknown): value is SlateThemePreference { return typeof value === "string" && (SLATE_THEME_PREFERENCES as readonly string[]).includes(value); }
export function isSlateDeepLinkPluginId(value: unknown): value is string { return typeof value === "string" && /^[0-9]{1,19}$/.test(value); }
export const SLATE_PLUGIN_DEEP_LINK_PATH = "/v1/plugin/add";
export function buildSlatePluginDeepLink(pluginId: string): string { return `slate://app${SLATE_PLUGIN_DEEP_LINK_PATH}?id=${encodeURIComponent(pluginId)}`; }
