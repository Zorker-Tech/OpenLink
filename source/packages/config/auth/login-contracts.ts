/** The token pair and the sign-in options shared by the login entry points. */
export interface LoginMetadata {
  readonly uuid: string;
  readonly verifier: string;
}

export interface CursorTokens {
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

function withoutTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveWebsiteUrl(url?: string): string {
  return withoutTrailingSlashes(url ?? process.env.CURSOR_WEBSITE_URL ?? "https://cursor.com");
}

export function resolveApiBaseUrl(url?: string): string {
  return withoutTrailingSlashes(url ?? process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh");
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
