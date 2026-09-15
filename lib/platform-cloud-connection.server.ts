import "server-only";
import {
  MemoryOAuthTokenStore,
  PlatformAuthClient,
} from "@vtslx/platform-sdk/auth";
import { createClient } from "@/utils/supabase/server";
import { getRuntimeMode } from "@/lib/runtime-mode.server";
import { createOpenLinkCloudSdk } from "@/lib/platform-cloud-sdk";
import {
  createCloudCredentialCipher,
  createCloudLoginCipher,
  createCloudRevocationSigner,
} from "@/lib/platform-cloud-crypto";
import {
  CloudOAuthVault,
  cloudConnectionCommand,
} from "@/lib/platform-cloud-vault";

export class CloudConnectionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function configuration() {
  try {
    const origin = new URL(process.env.OPENLINK_APP_URL ?? "");
    const clientId = process.env.OPENLINK_CLOUD_OAUTH_CLIENT_ID ?? "";
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !clientId.trim()
    )
      throw new Error("invalid public configuration");
    const encoded = JSON.parse(
      process.env.OPENLINK_CLOUD_OAUTH_KEYRING ?? "",
    ) as { active: string; keys: Record<string, string> };
    if (
      !encoded.keys ||
      typeof encoded.keys !== "object" ||
      Array.isArray(encoded.keys) ||
      Object.keys(encoded.keys).length > 16
    )
      throw new Error("invalid keyring");
    const keys = new Map(
      Object.entries(encoded.keys).map(([id, value]) => {
        if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
          throw new Error("invalid key encoding");
        return [id, Buffer.from(value, "base64")] as const;
      }),
    );
    const revocation = JSON.parse(
      process.env.OPENLINK_CLOUD_OAUTH_REVOCATION_KEY ?? "",
    ) as { id: string; key: string };
    if (
      typeof revocation.key !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(revocation.key)
    )
      throw new Error("invalid revocation key");
    return {
      clientId,
      origin: origin.origin,
      redirectUri: origin.origin + "/auth/platform/callback",
      cipher: createCloudCredentialCipher(keys, encoded.active),
      loginCipher: createCloudLoginCipher(keys, encoded.active),
      signRevocation: createCloudRevocationSigner(
        revocation.id,
        Buffer.from(revocation.key, "base64"),
      ),
    };
  } catch {
    throw new CloudConnectionError(503, "CLOUD_CONNECTION_NOT_CONFIGURED");
  }
}

async function authenticatedCloud() {
  if (getRuntimeMode() !== "cloud")
    throw new CloudConnectionError(404, "CLOUD_CONNECTION_UNAVAILABLE");
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user)
    throw new CloudConnectionError(401, "AUTHENTICATION_REQUIRED");
  return { user: data.user, client, command: cloudConnectionCommand(client) };
}
export {
  configuration as cloudOAuthConfiguration,
  authenticatedCloud as authenticatedCloudContext,
};

export async function listCloudConnections() {
  const { command } = await authenticatedCloud();
  const result = await command("list", null);
  if (result.outcome !== "listed" || !Array.isArray(result.connections))
    throw new Error("Invalid Cloud connection list");
  // Explicit projection: even a future RPC field must not expose encrypted secrets.
  return result.connections.map((row) => ({
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    state: row.state,
  }));
}

export async function getCloudConnection(connectionId: string) {
  const { user, command } = await authenticatedCloud();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      connectionId,
    )
  )
    throw new CloudConnectionError(400, "INVALID_CLOUD_CONNECTION_ID");
  const loaded = await command("load", connectionId);
  if (loaded.outcome === "missing" || !loaded.record)
    throw new CloudConnectionError(404, "CLOUD_CONNECTION_NOT_FOUND");
  const record = loaded.record;
  if (
    record.id !== connectionId ||
    record.user_id !== user.id ||
    record.issuer !== "https://auth.hydite.com"
  )
    throw new CloudConnectionError(403, "CLOUD_CONNECTION_IDENTITY_MISMATCH");
  const config = configuration();
  const vault = new CloudOAuthVault({
    mode: "cloud",
    userId: user.id,
    connectionId,
    subject: record.subject,
    clientId: record.client_id,
    command,
    cipher: config.cipher,
    signRevocation: config.signRevocation,
  });
  // load() performs the strict owner/client/revision check before credentials are used.
  const sdk = createOpenLinkCloudSdk({
    mode: "cloud",
    openlinkUserId: user.id,
    hyditeSubject: record.subject,
    clientId: record.client_id,
    redirectUri: config.redirectUri,
    tokenStore: vault,
    refreshCoordinator: vault,
  });
  return { sdk, vault, state: record.state };
}

export async function disconnectCloudConnection(connectionId: string) {
  const { sdk, vault } = await getCloudConnection(connectionId);
  await vault.clear(); // fence locally before making any external revocation call
  const pending = await vault.pendingRevocationTokens();
  if (pending) {
    const transient = new MemoryOAuthTokenStore();
    await transient.save(pending);
    const auth = new PlatformAuthClient({
      issuer: "https://auth.hydite.com",
      clientId: sdk.auth.clientId,
      redirectUri: sdk.auth.redirectUri,
      scopes: ["openid"],
      tokenStore: transient,
    });
    try {
      await auth.revoke();
    } catch {
      return { revoked: false, revocationPending: true };
    }
  }
  await vault.acknowledgeRevocation();
  return { revoked: true, revocationPending: false };
}
