import { SLATE_PLUGIN_DEEP_LINK_PATH } from "./desktop.ts";

export const SLATE_DEEP_LINK_SCHEME = "slate";
export const SLATE_DEEP_LINK_AUTHORITY = "app";
export const SLATE_HTTPS_DEEP_LINK_ORIGIN = "https://slate.invalid";
export const SLATE_HTTPS_DEEP_LINK_PATH_PREFIX = "/slate/link";
export const SLATE_DEEP_LINK_MAX_LENGTH = 2_048;
export const SLATE_OPEN_DEEP_LINK_URL = `${SLATE_DEEP_LINK_SCHEME}://${SLATE_DEEP_LINK_AUTHORITY}/v1/open`;

export const DEEP_LINK_INFO_PATH = "/v1/info";
export const DEEP_LINK_OPEN_PATH = "/v1/open";
export const DEEP_LINK_PLUGIN_PATH = SLATE_PLUGIN_DEEP_LINK_PATH;
export const HTTPS_DEEP_LINK_INFO_PATH = `${SLATE_HTTPS_DEEP_LINK_PATH_PREFIX}${DEEP_LINK_INFO_PATH}`;
export const HTTPS_DEEP_LINK_OPEN_PATH = `${SLATE_HTTPS_DEEP_LINK_PATH_PREFIX}${DEEP_LINK_OPEN_PATH}`;
export const HTTPS_DEEP_LINK_PLUGIN_PATH = `${SLATE_HTTPS_DEEP_LINK_PATH_PREFIX}${DEEP_LINK_PLUGIN_PATH}`;

export type DeepLinkSource = "protocol" | "https";

export type SlateDeepLink =
  | { readonly version: 1; readonly route: "info"; readonly topic: "deep-links"; readonly source: DeepLinkSource }
  | { readonly version: 1; readonly route: "plugin-add"; readonly pluginId: string; readonly source: DeepLinkSource }
  | { readonly version: 1; readonly route: "open"; readonly source: DeepLinkSource };

export interface ParsedSlateDeepLink {
  readonly link: SlateDeepLink;
  readonly canonicalUrl: string;
}
