import { resolveSlateBackendApiUrl, resolveSlateBackendWebsiteUrl } from "../../../adapters/interop/slate-backend/backend-endpoints.ts";

/** The token pair and the sign-in options shared by the login entry points. */
export interface LoginMetadata {
  readonly uuid: string;
  readonly verifier: string;
}

export interface SlateTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface LoginManagerOptions {
  readonly redirectTarget?: string;
  readonly apiUrl?: string;
  readonly websiteUrl?: string;
}

export interface LoginLinkHandler {
  openUrl(url: string): Promise<void>;
}

export interface ExchangeApiKeyOptions {
  readonly endpoint?: string;
}

export function resolveWebsiteUrl(url?: string): string {
  return resolveSlateBackendWebsiteUrl(url);
}

export function resolveApiBaseUrl(url?: string): string {
  return resolveSlateBackendApiUrl(url);
}

export class AuthNetworkError extends Error {
  constructor(cause: unknown) {
    const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    let safeProxy = "[proxy URL redacted]";
    if (rawProxy) {
      try {
        const proxy = new URL(rawProxy);
        proxy.username = "";
        proxy.password = "";
        safeProxy = proxy.toString();
      } catch {
        // Keep the redacted fallback.
      }
    }
    super(`Failed to reach the Slate API. ${rawProxy
      ? `Check that your proxy (${safeProxy}) is reachable.`
      : "If you are behind a corporate proxy, set the HTTPS_PROXY environment variable."}`);
    this.name = "AuthNetworkError";
    this.cause = cause;
  }
}
