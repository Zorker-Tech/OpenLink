/**
 * The skills the platform manages, and the marketplace catalog that offers more.
 *
 * Both reads go to the dashboard under one shared timeout. The managed list takes a skill the platform said nothing
 * about as enabled; the catalog skips a skill with no source to install from and a name it already listed, remembers
 * where each plugin's logo is so other surfaces can draw it, names a plugin by what it calls itself, and answers
 * sorted by skill name. A read that failed is reported, and the catalog answers with whatever it had collected — the
 * surface it feeds keeps working with less rather than with nothing.
 */

import { errorLogTag } from "../../../shared/errors/summary.ts";
import { CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS } from "../../../shared/node/marketplace/cursor-marketplace-client.ts";
import { rememberPluginLogoUrl } from "../../../shared/node/marketplace/cursor-marketplace-logo-registry.ts";

/** A skill the platform manages, as the dashboard hands it over. */
export interface ManagedSkillRecord {
  readonly id: string;
  readonly description: string;
  readonly content: string;
  readonly enabled?: boolean | null;
}

/** A plugin as the marketplace lists it, with the skills it brings. */
export interface MarketplacePlugin {
  readonly id: string | number | bigint;
  readonly name: string;
  readonly displayName: string;
  readonly logoUrl?: string | null;
  readonly publisher?: { readonly logoUrl?: string | null } | null;
  readonly skills: readonly { readonly name: string; readonly description?: string | null; readonly sourceUrl?: string | null }[];
}

/** The two dashboard reads this file makes, each under the marketplace's own timeout. */
export interface ManagedSkillsClient {
  getManagedSkills(request: Record<string, never>, options: { timeoutMs: number }): Promise<{ skills: readonly ManagedSkillRecord[] }>;
  listMarketplacePlugins(request: { excludeCloudAgentPlugins: true }, options: { timeoutMs: number }): Promise<{ plugins: readonly MarketplacePlugin[] }>;
}

/** What a catalog entry shows, and where a user would install it from. */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: "marketplace";
  publisher: string;
  iconUrl?: string;
  install: { kind: "url"; url: string };
}

export interface ManagedSkillsCatalogReport {
  extension: "managed_setup";
  kind: "skills_catalog";
  errorClass: string;
}

/** The skills the platform manages, with one it said nothing about taken as enabled. */
export async function fetchSlateManagedSkills(options: { client: ManagedSkillsClient }): Promise<Array<{ id: string; description: string; content: string; enabled: boolean }>> {
  const response = await options.client.getManagedSkills({}, { timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS });
  return response.skills.map((skill) => ({ id: skill.id, description: skill.description, content: skill.content, enabled: skill.enabled ?? true }));
}

/** Where a plugin's logo is, when it has one: its publisher's first, its own next. */
function pluginLogoUrl(plugin: MarketplacePlugin): string | undefined {
  return plugin.publisher?.logoUrl || plugin.logoUrl || undefined;
}

/** What a plugin is listed as: what it calls itself, and its name when it calls itself nothing. */
function pluginPublisherName(plugin: MarketplacePlugin): string {
  return plugin.displayName.length > 0 ? plugin.displayName : plugin.name;
}

/** The catalog the marketplace offers, one entry per skill that can be installed, sorted by name. */
export async function fetchSkillCatalog(client: ManagedSkillsClient, report?: (event: ManagedSkillsCatalogReport) => void): Promise<SkillCatalogEntry[]> {
  const entries: SkillCatalogEntry[] = [];
  const listedNames = new Set<string>();
  try {
    const response = await client.listMarketplacePlugins({ excludeCloudAgentPlugins: true }, { timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS });
    for (const plugin of response.plugins) {
      const iconUrl = pluginLogoUrl(plugin);
      for (const skill of plugin.skills) {
        const sourceUrl = skill.sourceUrl;
        if (!sourceUrl) continue;
        const name = skill.name.toLowerCase();
        if (listedNames.has(name)) continue;
        listedNames.add(name);
        if (iconUrl != null) rememberPluginLogoUrl(iconUrl);
        entries.push({
          id: `plugin:${plugin.id.toString()}:${skill.name}`,
          name: skill.name,
          description: skill.description ?? "",
          source: "marketplace",
          publisher: pluginPublisherName(plugin),
          ...(iconUrl == null ? {} : { iconUrl }),
          install: { kind: "url", url: sourceUrl },
        });
      }
    }
  } catch (error) {
    report?.({ extension: "managed_setup", kind: "skills_catalog", errorClass: errorLogTag(error) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
