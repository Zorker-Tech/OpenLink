import "server-only";
import {
  authenticatedCloudContext,
  cloudOAuthConfiguration,
  CloudConnectionError,
} from "@/lib/platform-cloud-connection.server";
import {
  beginCloudLogin,
  finishCloudLogin,
  parseCloudLoginCallback,
  CloudLoginError,
  type CloudLoginCommand,
} from "@/lib/platform-cloud-login";
import { CloudOAuthVault } from "@/lib/platform-cloud-vault";

async function context() {
  const current = await authenticatedCloudContext();
  const config = cloudOAuthConfiguration();
  const command: CloudLoginCommand = async (operation, loginId, payload) => {
    const { data, error } = await current.client
      .schema("openlink")
      .rpc("cloud_oauth_login_command", {
        p_operation: operation,
        p_login_id: loginId,
        p_payload: payload,
      });
    if (error || !data || typeof data !== "object")
      throw new CloudLoginError(503, "CLOUD_LOGIN_STORAGE_UNAVAILABLE");
    return data as Awaited<ReturnType<CloudLoginCommand>>;
  };
  return {
    current,
    config,
    login: {
      userId: current.user.id,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      cipher: config.loginCipher,
      command,
    },
  };
}

export async function startCloudConnectionLogin(request: Request) {
  const origin = new URL(process.env.OPENLINK_APP_URL ?? "");
  if (
    origin.protocol !== "https:" ||
    request.headers.get("origin") !== origin.origin
  )
    throw new CloudConnectionError(403, "ORIGIN_NOT_ALLOWED");
  if (process.env.OPENLINK_CLOUD_OAUTH_LOGIN_ENABLED !== "true")
    throw new CloudConnectionError(503, "CLOUD_LOGIN_NOT_ENABLED");
  const { current, login } = await context();
  const existing = await current.command("list", null);
  if (existing.outcome !== "listed" || !Array.isArray(existing.connections))
    throw new CloudConnectionError(503, "CLOUD_LOGIN_STORAGE_UNAVAILABLE");
  if (
    existing.connections?.some((row) =>
      ["active", "refreshing", "reauth_required"].includes(row.state),
    )
  )
    throw new CloudConnectionError(409, "CLOUD_CONNECTION_ALREADY_EXISTS");
  return beginCloudLogin(login);
}

export async function completeCloudConnectionLogin(request: Request) {
  const callback = parseCloudLoginCallback(request);
  const { current, config, login } = await context();
  const result = await finishCloudLogin(login, callback, async (input) => {
    const vault = new CloudOAuthVault({
      mode: "cloud",
      userId: current.user.id,
      connectionId: input.connectionId,
      subject: input.subject,
      clientId: input.clientId,
      command: current.command,
      cipher: config.cipher,
      signRevocation: config.signRevocation,
    });
    try {
      await vault.create(input.tokens);
    } catch {
      // Recover a successful write whose acknowledgement was lost, without
      // another grant exchange or overwriting a different generation.
      try {
        if (await vault.load()) return;
      } catch {
        /* inspect/fence below */
      }
      try {
        const found = await current.command("load", input.connectionId);
        if (found.outcome !== "missing") {
          await vault.clear();
          await input.auth.revoke();
          await vault.acknowledgeRevocation();
        }
      } catch {
        throw new CloudLoginError(503, "CLOUD_LOGIN_RECOVERY_REQUIRED");
      }
      throw new CloudLoginError(503, "CLOUD_LOGIN_STORAGE_UNAVAILABLE");
    }
  });
  const destination = new URL("/settings", config.origin);
  destination.searchParams.set(
    "cloud",
    result.connected ? "connected" : "cancelled",
  );
  if (result.connected)
    destination.searchParams.set("connectionId", result.connectionId);
  return { destination: destination.toString() };
}
