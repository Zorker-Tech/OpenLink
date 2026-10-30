import "server-only";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  MemoryOAuthTokenStore,
  PlatformAuthClient,
  type OAuthTokenSet,
} from "@vtslx/platform-sdk/auth";
import { getRuntimeMode } from "@/lib/runtime-mode.server";
import {
  cloudOAuthConfiguration,
  CloudConnectionError,
} from "@/lib/platform-cloud-connection.server";
import { CloudLoginError } from "@/lib/platform-cloud-login";
import type { CloudCredentialEnvelope } from "@/lib/platform-cloud-vault";
import { createClient } from "@/utils/supabase/server";
import { isCloudDevelopmentHttpOriginAllowed } from "@/lib/platform-cloud-origin";

const issuer = "https://auth.hydite.com";
const scopes = ["openid", "profile", "email"] as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statePattern = /^[A-Za-z0-9_-]{32,128}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const loginTtlMs = 10 * 60 * 1000;

function safeNextPath(value: string | null | undefined) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://openlink.invalid");
    if (url.origin !== "https://openlink.invalid") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

type IdentityLoginRecord = {
  id: string;
  user_id: string;
  connection_id: string;
  client_id: string;
  redirect_uri: string;
};

type IdentityLoginCookie = {
  record: IdentityLoginRecord;
  envelope: CloudCredentialEnvelope;
};

export function cloudIdentityLoginCookieConfiguration() {
  const secure = !isCloudDevelopmentHttpOriginAllowed();
  return {
    name: secure
      ? "__Host-openlink-cloud-identity-login"
      : "openlink-cloud-identity-login",
    secure,
  };
}

function configuration() {
  if (getRuntimeMode() !== "cloud")
    throw new CloudConnectionError(404, "CLOUD_AUTH_UNAVAILABLE");
  const oauth = cloudOAuthConfiguration();
  const provider =
    process.env.OPENLINK_CLOUD_SUPABASE_AUTH_PROVIDER?.trim() ||
    "custom:hydite";
  if (!/^custom:[a-z0-9][a-z0-9:-]{0,48}[a-z0-9]$/.test(provider))
    throw new CloudConnectionError(503, "CLOUD_AUTH_NOT_CONFIGURED");
  return {
    clientId: oauth.clientId,
    redirectUri: oauth.redirectUri,
    origin: oauth.origin,
    provider,
    cipher: oauth.loginCipher,
  };
}

function requestOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",", 1)[0]
    ?.trim();
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim();
  const protocol = forwardedProto || requestUrl.protocol.slice(0, -1);
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return "";
  }
}

export function cloudIdentityLoginOrigin() {
  return configuration().origin;
}

export function cloudIdentityRequestOrigin(request: Request) {
  return requestOrigin(request) || new URL(request.url).origin;
}

function authClient(
  clientId: string,
  redirectUri: string,
  store = new MemoryOAuthTokenStore(),
) {
  return new PlatformAuthClient({
    issuer,
    clientId,
    redirectUri,
    allowInsecureHttpRedirectOrigins:
      isCloudDevelopmentHttpOriginAllowed()
        ? [new URL(redirectUri).origin]
        : [],
    scopes,
    tokenStore: store,
  });
}

function setCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const matching = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matching.length !== 1) return null;
  const value = matching[0].slice(name.length + 1);
  if (!value || value.length > 8_000 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  return value;
}

function issueError() {
  return new CloudLoginError(400, "HYDITE_AUTH_FAILED");
}

function identityTokenDiagnostics(
  token: string,
  expectedAudience: string,
  expectedNonce: string,
) {
  const parts = token.split(".");
  if (parts.length !== 3) return { jwtFormat: false };

  try {
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const audience = claims.aud;
    const expiration = claims.exp;

    return {
      jwtFormat: true,
      algorithm:
        typeof header.alg === "string" &&
        /^[A-Za-z0-9-]{1,16}$/.test(header.alg)
          ? header.alg
          : "other",
      keyIdPresent: typeof header.kid === "string" && header.kid.length > 0,
      issuerMatches: claims.iss === issuer,
      audienceMatchesClient:
        audience === expectedAudience ||
        (Array.isArray(audience) && audience.includes(expectedAudience)),
      nonceClaimPresent:
        typeof claims.nonce === "string" && claims.nonce.length > 0,
      nonceMatchesRaw: claims.nonce === expectedNonce,
      nonceMatchesSupabaseHash:
        claims.nonce ===
        createHash("sha256").update(expectedNonce).digest("hex"),
      subjectPresent: typeof claims.sub === "string" && claims.sub.length > 0,
      emailClaimPresent:
        typeof claims.email === "string" && claims.email.length > 0,
      notExpired:
        typeof expiration === "number" && expiration > Date.now() / 1000,
      accessTokenHashPresent:
        typeof claims.at_hash === "string" && claims.at_hash.length > 0,
    };
  } catch {
    return { jwtFormat: false };
  }
}

function safeDiagnosticMessage(error: unknown) {
  if (process.env.NODE_ENV === "production" || !(error instanceof Error))
    return undefined;

  const message = error.message
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\beyJ[A-Za-z0-9._-]+\b/g, "<token>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<value>")
    .replace(/[^A-Za-z0-9 .,:_()/-]/g, "?")
    .trim();
  return message ? message.slice(0, 160) : undefined;
}

function identityFailureDetails(error: unknown) {
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; status?: unknown })
      : {};
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reason = message.includes("bad id token")
    ? "bad_id_token"
    : message.includes("nonce")
      ? "nonce_validation_failed"
      : message.includes("scope")
        ? "scope_validation_failed"
        : message.includes("email")
          ? "email_claim_missing_or_invalid"
          : message.includes("provider")
            ? "provider_rejected"
            : message.includes("oauth")
              ? "oauth_exchange_failed"
              : "request_rejected";
  const code =
    typeof candidate.code === "string" &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  const status =
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 100 &&
    candidate.status <= 599
      ? candidate.status
      : undefined;
  const diagnosticMessage = safeDiagnosticMessage(error);

  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    reason,
    ...(diagnosticMessage ? { diagnosticMessage } : {}),
    ...(code ? { errorCode: code } : {}),
    ...(status ? { status } : {}),
  };
}

function safeProviderError(value: string | null) {
  return value && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : value
      ? "other"
      : undefined;
}

export async function beginCloudIdentityLogin(request: Request) {
  const config = configuration();
  if (requestOrigin(request) !== config.origin)
    throw new CloudConnectionError(403, "ORIGIN_NOT_ALLOWED");

  const requestUrl = new URL(request.url);
  const nextPath = safeNextPath(requestUrl.searchParams.get("next"));
  const shareSession = requestUrl.searchParams.get("share") === "1";
  const auth = authClient(config.clientId, config.redirectUri);
  const pending = await auth.createAuthorizationRequest();
  const nonce = randomBytes(32).toString("base64url");
  const authorizationUrl = new URL(pending.url);
  // Supabase Auth checks id_token.nonce against SHA-256(raw nonce), encoded
  // as lowercase hex. Send that value to Hydite and retain the raw nonce for
  // conditional submission to signInWithIdToken.
  const providerNonce = createHash("sha256").update(nonce).digest("hex");
  authorizationUrl.searchParams.set("nonce", providerNonce);

  const id = randomUUID();
  const record: IdentityLoginRecord = {
    id,
    user_id: id,
    connection_id: randomUUID(),
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
  };
  const envelope = config.cipher.seal(
    {
      state: pending.state,
      codeVerifier: pending.codeVerifier,
      nonce,
      nextPath,
      shareSession,
      expiresAt: Date.now() + loginTtlMs,
    },
    record,
  );
  const cookieValue = Buffer.from(
    JSON.stringify({ record, envelope } satisfies IdentityLoginCookie),
  ).toString("base64url");
  if (cookieValue.length > 8_000)
    throw new CloudConnectionError(503, "CLOUD_AUTH_UNAVAILABLE");

  return {
    authorizationUrl: authorizationUrl.toString(),
    cookieName: cloudIdentityLoginCookieConfiguration().name,
    cookieValue,
  };
}

function parseIdentityLoginCookie(value: string, request: Request) {
  const config = configuration();
  const parsed = JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as Partial<IdentityLoginCookie>;
  const record = parsed.record;
  const envelope = parsed.envelope;
  if (
    !record ||
    !envelope ||
    !uuid.test(record.id ?? "") ||
    record.user_id !== record.id ||
    !uuid.test(record.connection_id ?? "") ||
    record.client_id !== config.clientId ||
    record.redirect_uri !== config.redirectUri ||
    requestOrigin(request) !== config.origin
  )
    throw issueError();

  let secrets: unknown;
  try {
    secrets = config.cipher.open(envelope, record);
  } catch {
    throw issueError();
  }
  if (!secrets || typeof secrets !== "object") throw issueError();
  const valueObject = secrets as Record<string, unknown>;
  if (
    typeof valueObject.state !== "string" ||
    !statePattern.test(valueObject.state) ||
    typeof valueObject.codeVerifier !== "string" ||
    !verifierPattern.test(valueObject.codeVerifier) ||
    typeof valueObject.nonce !== "string" ||
    !statePattern.test(valueObject.nonce) ||
    typeof valueObject.expiresAt !== "number" ||
    valueObject.expiresAt < Date.now() ||
    valueObject.expiresAt > Date.now() + loginTtlMs + 5_000 ||
    typeof valueObject.nextPath !== "string" ||
    safeNextPath(valueObject.nextPath) !== valueObject.nextPath ||
    typeof valueObject.shareSession !== "boolean"
  )
    throw issueError();

  return {
    record,
    secrets: valueObject as {
      state: string;
      codeVerifier: string;
      nonce: string;
      nextPath: string;
      shareSession: boolean;
      expiresAt: number;
    },
    config,
  };
}

export function hasCloudIdentityLoginCookie(request: Request) {
  const name = cloudIdentityLoginCookieConfiguration().name;
  const matching = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matching.length === 1;
}

export function matchesCloudIdentityLoginCallback(request: Request) {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  if (
    query.getAll("state").length !== 1 ||
    !state ||
    !statePattern.test(state)
  )
    return false;

  const cookieValue = setCookie(
    request,
    cloudIdentityLoginCookieConfiguration().name,
  );
  if (!cookieValue) return false;

  try {
    const cookie = parseIdentityLoginCookie(cookieValue, request);
    return (
      state.length === cookie.secrets.state.length &&
      timingSafeEqual(Buffer.from(state), Buffer.from(cookie.secrets.state))
    );
  } catch {
    return false;
  }
}

export async function completeCloudIdentityLogin(request: Request): Promise<{
  nextPath: string;
  shareSession: boolean;
  origin: string;
}> {
  let stage = "read_login_cookie";
  let providerError: string | undefined;
  let auth: ReturnType<typeof authClient> | undefined;
  let exchanged = false;
  let tokenDiagnostics: ReturnType<typeof identityTokenDiagnostics> | undefined;
  try {
    const cookieConfig = cloudIdentityLoginCookieConfiguration();
    const cookieValue = setCookie(request, cookieConfig.name);
    if (!cookieValue) throw issueError();

    stage = "validate_callback_parameters";
    const query = new URL(request.url).searchParams;
    const state = query.get("state");
    const code = query.get("code");
    if (
      query.getAll("state").length !== 1 ||
      !state ||
      !statePattern.test(state) ||
      query.getAll("code").length > 1 ||
      query.getAll("error").length > 1 ||
      (query.has("error") && query.has("code"))
    )
      throw issueError();

    stage = "decrypt_login_state";
    let cookie: ReturnType<typeof parseIdentityLoginCookie>;
    try {
      cookie = parseIdentityLoginCookie(cookieValue, request);
    } catch {
      throw issueError();
    }

    stage = "validate_oauth_state";
    if (
      state.length !== cookie.secrets.state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(cookie.secrets.state))
    )
      throw issueError();

    if (query.has("error")) {
      stage = "identity_provider_error";
      providerError = safeProviderError(query.get("error"));
      throw issueError();
    }
    if (!code || code.length > 4_096) throw issueError();

    const store = new MemoryOAuthTokenStore();
    auth = authClient(cookie.config.clientId, cookie.config.redirectUri, store);

    stage = "exchange_authorization_code";
    const tokens: OAuthTokenSet = await auth.exchangeAuthorizationCode({
      code,
      codeVerifier: cookie.secrets.codeVerifier,
    });
    exchanged = true;
    if (!tokens.idToken) throw issueError();

    // Resolve identity through the pinned issuer before passing the opaque ID
    // token to Supabase Auth, which verifies its signature, issuer, audience,
    // and a nonce claim when the provider returned one.
    stage = "fetch_identity_profile";
    const identity = await auth.userInfo();
    if (!identity.sub || !identity.email) throw issueError();

    stage = "create_supabase_session";
    tokenDiagnostics = identityTokenDiagnostics(
      tokens.idToken,
      cookie.config.clientId,
      cookie.secrets.nonce,
    );
    // GoTrue hashes the nonce argument before comparing it with the signed
    // claim. If Hydite omitted that claim, omit the argument too; otherwise
    // GoTrue would reject a valid code-flow ID token for a one-sided nonce.
    const nonceMatchesSupabaseHash =
      "nonceMatchesSupabaseHash" in tokenDiagnostics &&
      tokenDiagnostics.nonceMatchesSupabaseHash;
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: cookie.config.provider,
      token: tokens.idToken,
      access_token: tokens.accessToken,
      ...(nonceMatchesSupabaseHash ? { nonce: cookie.secrets.nonce } : {}),
    });
    if (error) throw error;
    if (!data.user) throw issueError();

    return {
      nextPath: cookie.secrets.nextPath,
      shareSession: cookie.secrets.shareSession,
      origin: cookie.config.origin,
    };
  } catch (error) {
    console.error("[OpenLink Cloud Auth] Hydite callback failed", {
      stage,
      ...identityFailureDetails(error),
      ...(process.env.NODE_ENV !== "production" && tokenDiagnostics
        ? { identityToken: tokenDiagnostics }
        : {}),
      ...(providerError ? { providerError } : {}),
    });
    throw issueError();
  } finally {
    if (exchanged && auth) await auth.revoke().catch(() => undefined);
  }
}
