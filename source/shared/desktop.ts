export const SLATE_THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type SlateThemePreference = (typeof SLATE_THEME_PREFERENCES)[number];

const THEME_PREFERENCE_SET: ReadonlySet<string> = new Set(SLATE_THEME_PREFERENCES);
const APP_LINK_ORIGIN = "slate://app";
const PLUGIN_ID_PARAMETER = "id";
const NUMERIC_PLUGIN_ID = /^[0-9]{1,19}$/;

export const DEFAULT_SLATE_THEME_PREFERENCE: SlateThemePreference = "system";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isSlateThemePreference(value: unknown): value is SlateThemePreference {
  return isString(value) && THEME_PREFERENCE_SET.has(value);
}

function isNumericPluginId(value: string): boolean {
  return NUMERIC_PLUGIN_ID.test(value);
}

export function isSlateDeepLinkPluginId(value: unknown): value is string {
  return isString(value) && isNumericPluginId(value);
}

export const SLATE_PLUGIN_DEEP_LINK_PATH = "/v1/plugin/add";

function pluginIdParameter(pluginId: string): string {
  return `${PLUGIN_ID_PARAMETER}=${encodeURIComponent(pluginId)}`;
}

export function buildSlatePluginDeepLink(pluginId: string): string {
  return `${APP_LINK_ORIGIN}${SLATE_PLUGIN_DEEP_LINK_PATH}?${pluginIdParameter(pluginId)}`;
}
