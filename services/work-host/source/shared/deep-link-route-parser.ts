import { isSlateDeepLinkPluginId } from "./desktop.ts";
import {
  DEEP_LINK_INFO_PATH,
  DEEP_LINK_OPEN_PATH,
  DEEP_LINK_PLUGIN_PATH,
  HTTPS_DEEP_LINK_INFO_PATH,
  HTTPS_DEEP_LINK_OPEN_PATH,
  HTTPS_DEEP_LINK_PLUGIN_PATH,
  type DeepLinkSource,
  type ParsedSlateDeepLink,
  type SlateDeepLink,
} from "./deep-link-contracts.ts";
import { canonicalSlateDeepLinkUrl } from "./deep-link-canonical.ts";
import { readAllowlistedQuery } from "./deep-link-query-policy.ts";

function pluginAddFrom(url: URL, source: DeepLinkSource): ParsedSlateDeepLink | null {
  const entries = [...url.searchParams];
  if (entries.length !== 1) return null;
  const onlyEntry = entries[0];
  if (onlyEntry === undefined) return null;
  const [key, pluginId] = onlyEntry;
  if (key !== "id" || !isSlateDeepLinkPluginId(pluginId)) return null;

  const link: SlateDeepLink = { version: 1, route: "plugin-add", pluginId, source };
  return { link, canonicalUrl: canonicalSlateDeepLinkUrl(link) };
}

function openAppFrom(url: URL, source: DeepLinkSource): ParsedSlateDeepLink | null {
  if (readAllowlistedQuery(url, {}) === null) return null;
  const link: SlateDeepLink = { version: 1, route: "open", source };
  return { link, canonicalUrl: canonicalSlateDeepLinkUrl(link) };
}

function infoPageFrom(url: URL, source: DeepLinkSource): ParsedSlateDeepLink | null {
  if (readAllowlistedQuery(url, { topic: ["deep-links"] }) === null) return null;
  const link: SlateDeepLink = { version: 1, route: "info", topic: "deep-links", source };
  return { link, canonicalUrl: canonicalSlateDeepLinkUrl(link) };
}

export function parseDeepLinkRoute(url: URL, source: DeepLinkSource): ParsedSlateDeepLink | null {
  const path = url.pathname;
  const pluginPath = source === "protocol" ? DEEP_LINK_PLUGIN_PATH : HTTPS_DEEP_LINK_PLUGIN_PATH;
  const openPath = source === "protocol" ? DEEP_LINK_OPEN_PATH : HTTPS_DEEP_LINK_OPEN_PATH;
  const infoPath = source === "protocol" ? DEEP_LINK_INFO_PATH : HTTPS_DEEP_LINK_INFO_PATH;

  if (path === pluginPath) return pluginAddFrom(url, source);
  if (path === openPath) return openAppFrom(url, source);
  if (path === infoPath) return infoPageFrom(url, source);
  return null;
}
