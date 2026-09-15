import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MemoryOAuthTokenStore,
  PlatformAuthClient,
} from "@vtslx/platform-sdk/auth";
import type { OAuthTokenSet } from "@vtslx/platform-sdk/auth";
import type { CloudCredentialEnvelope } from "./platform-cloud-vault";

export const cloudLoginCookie = "__Host-openlink-cloud-oauth";
export const cloudLoginScopes = [
  "openid",
  "profile",
  "email",
  "computer:read",
  "computer:write",
] as const;
export type CloudLoginRecord = {
  id: string;
  user_id: string;
  connection_id: string;
  client_id: string;
  redirect_uri: string;
  expires_at?: string;
  envelope?: CloudCredentialEnvelope;
};
export type CloudLoginSecrets = { state: string; codeVerifier: string };
export type CloudLoginCipher = {
  seal(
    value: CloudLoginSecrets,
    record: CloudLoginRecord,
  ): CloudCredentialEnvelope;
  open(value: CloudCredentialEnvelope, record: CloudLoginRecord): unknown;
};
export type CloudLoginCommand = (
  operation: string,
  loginId: string,
  payload: Record<string, unknown>,
) => Promise<{ outcome: string; record?: CloudLoginRecord }>;
export class CloudLoginError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statePattern = /^[A-Za-z0-9_-]{32,128}$/;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function parseCloudLoginCallback(request: Request) {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  const cookies = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(cloudLoginCookie + "="));
  const parts =
    cookies.length === 1
      ? cookies[0].slice(cloudLoginCookie.length + 1).split(".")
      : [];
  if (
    query.getAll("state").length !== 1 ||
    !state ||
    !statePattern.test(state) ||
    parts.length !== 2 ||
    !uuid.test(parts[0]) ||
    !statePattern.test(parts[1]) ||
    state.length !== parts[1].length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(parts[1]))
  )
    throw new CloudLoginError(400, "INVALID_CLOUD_LOGIN_STATE");
  const code = query.get("code"),
    denied = query.has("error");
  if (
    query.getAll("code").length > 1 ||
    query.getAll("error").length > 1 ||
    (denied && query.has("code")) ||
    (!denied && (!code || code.length > 4096)) ||
    (denied && (query.get("error")?.length ?? 0) > 128)
  )
    throw new CloudLoginError(400, "INVALID_CLOUD_LOGIN_CALLBACK");
  return { loginId: parts[0], state, code, denied };
}

export type CloudLoginContext = {
  userId: string;
  clientId: string;
  redirectUri: string;
  cipher: CloudLoginCipher;
  command: CloudLoginCommand;
  fetch?: typeof globalThis.fetch;
};
function client(
  context: CloudLoginContext,
  store: MemoryOAuthTokenStore,
  clientId = context.clientId,
) {
  return new PlatformAuthClient({
    issuer: "https://auth.hydite.com",
    clientId,
    redirectUri: context.redirectUri,
    scopes: cloudLoginScopes,
    tokenStore: store,
    fetch: context.fetch,
  });
}
export async function beginCloudLogin(context: CloudLoginContext) {
  const auth = client(context, new MemoryOAuthTokenStore());
  const pending = await auth.createAuthorizationRequest();
  const record: CloudLoginRecord = {
    id: randomUUID(),
    user_id: context.userId,
    connection_id: randomUUID(),
    client_id: context.clientId,
    redirect_uri: context.redirectUri,
  };
  const result = await context.command("begin", record.id, {
    connection_id: record.connection_id,
    client_id: record.client_id,
    redirect_uri: record.redirect_uri,
    state_hash: hash(pending.state),
    envelope: context.cipher.seal(
      { state: pending.state, codeVerifier: pending.codeVerifier },
      record,
    ),
  });
  if (result.outcome === "rate_limited")
    throw new CloudLoginError(429, "CLOUD_LOGIN_RATE_LIMITED");
  if (
    result.outcome !== "created" ||
    result.record?.id !== record.id ||
    result.record.user_id !== context.userId ||
    result.record.connection_id !== record.connection_id
  )
    throw new CloudLoginError(503, "CLOUD_LOGIN_STORAGE_UNAVAILABLE");
  return {
    authorizationUrl: pending.url,
    cookieValue: record.id + "." + pending.state,
  };
}

/** The host supplies durable connection persistence and cleanup, not OAuth code. */
export async function finishCloudLogin(
  context: CloudLoginContext,
  callback: ReturnType<typeof parseCloudLoginCallback>,
  persist: (input: {
    connectionId: string;
    subject: string;
    clientId: string;
    tokens: OAuthTokenSet;
    auth: PlatformAuthClient;
  }) => Promise<void>,
) {
  const consumed = await context.command("consume", callback.loginId, {
    state_hash: hash(callback.state),
  });
  const record = consumed.record;
  if (
    consumed.outcome !== "consumed" ||
    !record?.envelope ||
    record.id !== callback.loginId ||
    record.user_id !== context.userId ||
    !uuid.test(record.connection_id) ||
    record.redirect_uri !== context.redirectUri ||
    !record.client_id ||
    !record.expires_at ||
    !Number.isFinite(Date.parse(record.expires_at)) ||
    Date.parse(record.expires_at) <= Date.now()
  )
    throw new CloudLoginError(400, "CLOUD_LOGIN_EXPIRED_OR_CONSUMED");
  let value: Partial<CloudLoginSecrets>;
  try {
    value = context.cipher.open(
      record.envelope,
      record,
    ) as Partial<CloudLoginSecrets>;
  } catch {
    throw new CloudLoginError(400, "INVALID_CLOUD_LOGIN_BINDING");
  }
  if (
    !value ||
    value.state !== callback.state ||
    typeof value.codeVerifier !== "string" ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(value.codeVerifier)
  )
    throw new CloudLoginError(400, "INVALID_CLOUD_LOGIN_BINDING");
  if (callback.denied) return { connected: false as const };
  const store = new MemoryOAuthTokenStore(),
    auth = client(context, store, record.client_id);
  try {
    const tokens = await auth.exchangeAuthorizationCode({
      code: callback.code!,
      codeVerifier: value.codeVerifier,
    });
    const identity = await auth.userInfo();
    await persist({
      connectionId: record.connection_id,
      subject: identity.sub,
      clientId: record.client_id,
      tokens,
      auth,
    });
    await store.clear();
    return { connected: true as const, connectionId: record.connection_id };
  } catch (error) {
    let recoveryRequired =
      error instanceof CloudLoginError &&
      error.message === "CLOUD_LOGIN_RECOVERY_REQUIRED";
    try {
      await auth.revoke();
    } catch {
      recoveryRequired = true;
    }
    throw new CloudLoginError(
      503,
      recoveryRequired ? "CLOUD_LOGIN_RECOVERY_REQUIRED" : "CLOUD_LOGIN_FAILED",
    );
  }
}
