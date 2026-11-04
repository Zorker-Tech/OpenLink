import { buildSlatePluginDeepLink } from "./desktop.ts";
import {
  SLATE_DEEP_LINK_AUTHORITY,
  SLATE_DEEP_LINK_SCHEME,
  SLATE_OPEN_DEEP_LINK_URL,
  type SlateDeepLink,
} from "./deep-link-contracts.ts";

export function canonicalSlateDeepLinkUrl(link: SlateDeepLink): string {
  switch (link.route) {
    case "info":
      return `${SLATE_DEEP_LINK_SCHEME}://${SLATE_DEEP_LINK_AUTHORITY}/v1/info?topic=${link.topic}`;
    case "plugin-add":
      return buildSlatePluginDeepLink(link.pluginId);
    case "open":
      return SLATE_OPEN_DEEP_LINK_URL;
  }
}
