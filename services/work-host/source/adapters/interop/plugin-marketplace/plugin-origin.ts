import type { PluginOrigin } from "../../../packages/plugin-install/plugin-origin.ts"

export type { PluginOrigin }

/** Converts the marketplace's public-feed marker into Slate's own origin category. */
export function pluginOriginFromMarketplaceName(name: string | undefined): PluginOrigin {
  return name === undefined || name.length === 0 || name === "cursor-public"
    ? "first-party"
    : "third-party";
}
