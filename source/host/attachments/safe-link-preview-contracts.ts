import type { IncomingHttpHeaders } from "node:http";
import { SLATE_BRAND } from "../../shared/product-name.ts";

export const MAX_URL_LENGTH = 2_048;
export const MAX_REDIRECTS = 5;
export const LINK_PREVIEW_USER_AGENT = `${SLATE_BRAND.httpToken}-LinkPreview/1.0`;

export class SlateLinkPreviewError extends Error {}

export interface SafeConnectionTarget {
  readonly connectHost: string;
  readonly hostHeader: string;
  readonly servername?: string;
}

export interface LinkPreviewResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly finalUrl: string;
  readonly redirectUrls: readonly string[];
}

export interface LinkPreviewFetchOptions {
  readonly maxBytes: number;
  readonly accept: string;
  readonly truncateAtByteLimit?: boolean;
}

export interface RawLinkPreviewResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}
