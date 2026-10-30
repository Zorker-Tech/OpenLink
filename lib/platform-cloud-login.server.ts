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
import {
  configuredCloudAppOrigin,
  isCloudDevelopmentHttpOriginAllowed,
} from "@/lib/platform-cloud-origin";

function normalizeCloudLoginReturnPath(value: unknown, origin: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096)
    throw new CloudConnectionError(400, "INVALID_CLOUD_LOGIN_RETURN_PATH");
  let target: URL;
  try {
    target = new URL(value, origin);
  } catch {
    throw new CloudConnectionError(400, "INVALID_CLOUD_LOGIN_RETURN_PATH");
  }
  const keys = [...target.searchParams.keys()];
  if (
    target.origin !== origin ||
    target.username ||
    target.password ||
    target.hash ||
    target.pathname !== "/app/onboarding" ||
    target.searchParams.getAll("step").length !== 1 ||
    target.searchParams.get("step") !== "project" ||
    target.searchParams.getAll("prompt").length > 1 ||
    keys.some((key) => key !== "step" && key !== "prompt") ||
    (target.searchParams.get("prompt")?.length ?? 0) > 4000
  )
    throw new CloudConnectionError(400, "INVALID_CLOUD_LOGIN_RETURN_PATH");
  const prompt = target.searchParams.get("prompt");
  return `/app/onboarding?step=project${prompt ? `&prompt=${encodeURIComponent(prompt)}` : ""}`;
}

async function requestedCloudLoginReturnPath(request: Request, origin: string) {
  if (!request.body) return undefined;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 4096)
    throw new CloudConnectionError(413, "CLOUD_LOGIN_REQUEST_TOO_LARGE");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) {
        await reader.cancel().catch(() => undefined);
        throw new CloudConnectionError(413, "CLOUD_LOGIN_REQUEST_TOO_LARGE");
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch (error) {
    if (error instanceof CloudConnectionError) throw error;
    throw new CloudConnectionError(400, "INVALID_CLOUD_LOGIN_REQUEST");
  } finally {
    reader.releaseLock();
  }
  if (!raw.trim()) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new CloudConnectionError(400, "INVALID_CLOUD_LOGIN_REQUEST");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new CloudConnectionError(400, "INVALID_CLOUD_LOGIN_REQUEST");
  return normalizeCloudLoginReturnPath(
    (body as { nextPath?: unknown }).nextPath,
    origin,
  );
}

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
      allowInsecureHttpRedirectOrigins:
        isCloudDevelopmentHttpOriginAllowed() ? [config.origin] : [],
      cipher: config.loginCipher,
      command,
    },
  };
}

export async function startCloudConnectionLogin(request: Request) {
  const origin = configuredCloudAppOrigin();
  if (request.headers.get("origin") !== origin.origin)
    throw new CloudConnectionError(403, "ORIGIN_NOT_ALLOWED");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.OPENLINK_CLOUD_OAUTH_LOGIN_ENABLED !== "true"
  )
    throw new CloudConnectionError(503, "CLOUD_LOGIN_NOT_ENABLED");
  const nextPath = await requestedCloudLoginReturnPath(request, origin.origin);
  const { current, config, login } = await context();
  const existing = await current.command("list", null);
  if (existing.outcome !== "listed" || !Array.isArray(existing.connections))
    throw new CloudConnectionError(503, "CLOUD_LOGIN_STORAGE_UNAVAILABLE");
  const currentConnections = existing.connections.filter((row) =>
    ["active", "refreshing", "reauth_required"].includes(row.state),
  );
  if (currentConnections.length > 1)
    throw new CloudConnectionError(503, "CLOUD_CONNECTION_STATE_INVALID");
  const reauthorization = currentConnections[0]?.state === "reauth_required"
    ? currentConnections[0]
    : undefined;
  if (currentConnections.some((row) => row.state === "active" || row.state === "refreshing"))
    throw new CloudConnectionError(409, "CLOUD_CONNECTION_ALREADY_EXISTS");
  if (reauthorization && reauthorization.client_id !== config.clientId)
    throw new CloudConnectionError(409, "CLOUD_CONNECTION_CLIENT_MISMATCH");
  return beginCloudLogin(
    login,
    nextPath,
    reauthorization
      ? { connectionId: reauthorization.id, expectedSubject: reauthorization.subject }
      : undefined,
  );
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
    if (input.expectedSubject && input.expectedSubject !== input.subject) {
      throw new CloudLoginError(403, "CLOUD_REAUTHORIZATION_IDENTITY_MISMATCH");
    }
    if (input.expectedSubject) {
      try {
        await vault.reauthorize(input.tokens);
      } catch (error) {
        if (error instanceof Error && error.message === "Cloud reauthorization outcome is uncertain") {
          throw new CloudLoginError(503, "CLOUD_LOGIN_RECOVERY_REQUIRED");
        }
        throw new CloudLoginError(503, "CLOUD_LOGIN_STORAGE_UNAVAILABLE");
      }
      return;
    }
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
  const nextPath = normalizeCloudLoginReturnPath(result.nextPath, config.origin);
  const destination = nextPath
    ? new URL(nextPath, config.origin)
    : new URL("/settings", config.origin);
  if (!nextPath) {
    destination.searchParams.set(
      "cloud",
      result.connected ? "connected" : "cancelled",
    );
    if (result.connected)
      destination.searchParams.set("connectionId", result.connectionId);
  }
  return { destination: destination.toString() };
}
