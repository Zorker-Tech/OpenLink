/**
 * The platform's own access token.
 *
 * The token is a JWT, so what it says can be read without asking anyone: the account it belongs to, and when it stops
 * being valid — with a little room before that, since a token that expires mid-request is worse than one refreshed
 * early. The backend it belongs to is the platform's own, and which client it was issued to depends on whether the
 * backend is a development one.
 */
import { createHash } from "node:crypto";

export const DEFAULT_BACKEND_URL = "https://api.slate.invalid";
export const PROD_AUTH_CLIENT_ID = "";
export const DEV_AUTH_CLIENT_ID = "";
export const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export interface JwtPayload { readonly email?: string; readonly exp?: number; readonly sub?: string; readonly [key: string]: unknown; }

export function parseJwtPayload(token: string): JwtPayload | null {
  const [, payload] = token.split(".");
  if (payload == null || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.email !== undefined && typeof record.email !== "string") return null;
    if (record.exp !== undefined && typeof record.exp !== "number") return null;
    if (record.sub !== undefined && typeof record.sub !== "string") return null;
    return record as JwtPayload;
  } catch { return null; }
}

export function accountCacheScope(accessToken: string): string {
  return createHash("sha256").update(parseJwtPayload(accessToken)?.sub ?? accessToken).digest("hex");
}

export function isTokenExpiringSoon(token: string, now = Date.now()): boolean {
  const payload = parseJwtPayload(token);
  return payload?.exp == null || payload.exp * 1_000 - now < TOKEN_REFRESH_LEEWAY_MS;
}

export function getAccessTokenExpiryMs(token: string): number | null {
  const exp = parseJwtPayload(token)?.exp;
  return exp == null || !Number.isFinite(exp) ? null : exp * 1_000;
}

export function getConfiguredBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(env.SLATE_BACKEND_URL ?? DEFAULT_BACKEND_URL).toString();
}

export function getAuthClientId(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SLATE_AUTH_CLIENT_ID;
  if (configured != null && configured.length > 0) return configured;
  const hostname = new URL(backendUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".lclhst.build") || hostname === "dev-staging.slate.invalid" ? DEV_AUTH_CLIENT_ID : PROD_AUTH_CLIENT_ID;
}

export function isDevAuthBackend(backendUrl: string): boolean { return getAuthClientId(backendUrl) !== PROD_AUTH_CLIENT_ID; }
export function shouldRefreshAccessToken(backendUrl: string, accessToken: string): boolean { return isTokenExpiringSoon(accessToken) || isDevAuthBackend(backendUrl); }
