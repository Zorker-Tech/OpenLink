/**
 * The loopback server an MCP connector's authorization comes back to.
 *
 * The redirect the connector sends is answered only when it belongs to this server and names the state it was given, and
 * what it carried is handed on once, so an answer cannot be replayed onto another flow.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createRealExpiryPolicy,
  createRealPollingPolicy,
  createRealRetryPolicy,
  type ExpiryPolicy,
  type PollingPolicy,
  type RetryPolicy,
} from "../../../host/extensions/scheduling.ts";
import {
  isSlateDeadlineExceededError,
  isSlateRateLimitError,
  isSlateTransientRemoteError,
} from "../../network/remote-rpc-error.ts";
import { brandedEnumOf } from "../../errors/bounded-values.ts";
import { SlateError } from "../../errors/registry.ts";
import {
  renderMcpOAuthErrorPage as renderErrorPage,
  renderMcpOAuthSuccessPage as renderSuccessPage,
} from "../../mcp-oauth-callback-page.ts";
const renderMcpOAuthSuccessPage = (args: {
  serverName: string | undefined;
}): string =>
  renderSuccessPage(
    args.serverName == null ? undefined : { serverName: args.serverName },
  );
const renderMcpOAuthErrorPage = (args: {
  serverName: string | undefined;
}): string =>
  renderErrorPage(
    args.serverName == null ? undefined : { serverName: args.serverName },
  );
export const MCP_OAUTH_LOOPBACK_CALLBACK_URL =
  "http://localhost:8787/callback";
const BACKEND_MCP_OAUTH_PENDING_STATE_TTL_MS = 15 * 60 * 1_000;
const MCP_OAUTH_PENDING_TTL_MS = BACKEND_MCP_OAUTH_PENDING_STATE_TTL_MS + 60_000;
const MCP_OAUTH_COMPLETION_RETRY_DELAY_MS = 500;
const MCP_OAUTH_BIND_RETRY_INTERVAL_MS = 2_000;
export const CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS = [
  "provider_error",
  "missing_code",
  "completion_rejected",
  "completion_timeout",
] as const;
const callbackFailureReason = brandedEnumOf(
  CONNECTOR_OAUTH_CALLBACK_FAILURE_REASONS,
  "completion_rejected",
);
const isLoopback = (host: string): boolean =>
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
const loopbackBindHosts = (redirectHost: string): readonly string[] =>
  redirectHost === "localhost" ? ["127.0.0.1", "::1"] : [redirectHost];
export function parseMcpOAuthLoopbackAuthorization(
  url: string,
  callback = MCP_OAUTH_LOOPBACK_CALLBACK_URL,
): { state: string } | null {
  let authorization: URL, loopback: URL;
  try {
    authorization = new URL(url);
    loopback = new URL(callback);
  } catch {
    return null;
  }
  const raw = authorization.searchParams.get("redirect_uri"),
    state = authorization.searchParams.get("state");
  if (raw == null || state == null || state.length === 0) return null;
  let redirect: URL;
  try {
    redirect = new URL(raw);
  } catch {
    return null;
  }
  return redirect.protocol === "http:" &&
    isLoopback(redirect.hostname) &&
    redirect.port === loopback.port &&
    redirect.pathname === loopback.pathname
    ? { state }
    : null;
}
export function createSlateMcpOAuthLoopback(deps: {
  completeOAuth(args: { stateId: string; code: string }): Promise<void>;
  log(message: string): void;
  loopbackRedirectUrl?: string;
  pendingExpiry?: ExpiryPolicy;
  completionRetry?: RetryPolicy;
  bindRetry?: PollingPolicy;
  onCallback?(event: Record<string, unknown>): void;
}) {
  const redirectUrl = deps.loopbackRedirectUrl ?? MCP_OAUTH_LOOPBACK_CALLBACK_URL,
    redirectTarget = new URL(redirectUrl),
    pendingExpiry =
      deps.pendingExpiry ??
      createRealExpiryPolicy({
        name: "slate-mcp-oauth-loopback-pending",
        ttlMs: MCP_OAUTH_PENDING_TTL_MS,
      }),
    completionRetry =
      deps.completionRetry ??
      createRealRetryPolicy({
        name: "slate-mcp-oauth-loopback-completion",
        maxAttempts: 2,
        initialDelayMs: MCP_OAUTH_COMPLETION_RETRY_DELAY_MS,
        maxDelayMs: MCP_OAUTH_COMPLETION_RETRY_DELAY_MS,
        shouldRetry: (error) =>
          isSlateTransientRemoteError(error) && !isSlateRateLimitError(error),
      }),
    bindRetry =
      deps.bindRetry ??
      createRealPollingPolicy({
        name: "slate-mcp-oauth-loopback-bind-retry",
        intervalMs: MCP_OAUTH_BIND_RETRY_INTERVAL_MS,
      }),
    bindAddresses = loopbackBindHosts(redirectTarget.hostname),
    bindPort = Number.parseInt(redirectTarget.port, 10);
  type Pending = {
    serverName?: string | undefined;
    expiry: { dispose(): void };
    completing: Promise<{ kind: string }> | null;
  };
  const pendingStates = new Map<string, Pending>(),
    listeners = new Map<string, Server>();
  let binding: Promise<void> | null = null,
    bindTimer: { dispose(): void } | null = null,
    isDisposed = false,
    loggedBindFailure = false,
    listenersClosed = Promise.resolve();
  const closeListening = async (serversToClose: Server[]): Promise<void> => {
    await Promise.all(
      serversToClose
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeIdleConnections?.();
            }),
        ),
    );
  };
  const stopBindTimer = () => {
    bindTimer?.dispose();
    bindTimer = null;
  };
  const closeWhenDrained = () => {
    if (pendingStates.size > 0) return;
    stopBindTimer();
    loggedBindFailure = false;
    if (listeners.size === 0) return;
    const items = [...listeners.values()];
    listeners.clear();
    listenersClosed = listenersClosed
      .then(() => closeListening(items))
      .catch(() => undefined);
  };
  const forgetState = (state: string) => {
    const flow = pendingStates.get(state);
    if (flow == null) return;
    pendingStates.delete(state);
    flow.expiry.dispose();
    closeWhenDrained();
  };
  const finishFlow = async (state: string, flow: Pending, requestUrl: URL) => {
    const serverName = flow.serverName;
    const fail = (reason: string) =>
      deps.onCallback?.({
        phase: "callback_received",
        outcome: "failed",
        serverName,
        error: SlateError.connectorOauthCallbackFailed({
          reason: callbackFailureReason(reason),
        }),
      });
    if (requestUrl.searchParams.get("error") != null) {
      fail("provider_error");
      forgetState(state);
      return { kind: "refused" };
    }
    const code = requestUrl.searchParams.get("code");
    if (code == null || code.length === 0) {
      fail("missing_code");
      forgetState(state);
      return { kind: "refused" };
    }
    try {
      await completionRetry.runWithRetry(() =>
        deps.completeOAuth({ stateId: state, code }),
      );
      deps.onCallback?.({
        phase: "callback_received",
        outcome: "ok",
        serverName,
      });
      forgetState(state);
      return { kind: "success" };
    } catch (error) {
      fail(
        isSlateDeadlineExceededError(error)
          ? "completion_timeout"
          : "completion_rejected",
      );
      deps.log(
        `[slate:mcp] loopback OAuth completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (isSlateTransientRemoteError(error)) flow.completing = null;
      else forgetState(state);
      return { kind: "failed" };
    }
  };
  const serveCallback = async (requestUrl: URL, httpMethod: string, response: ServerResponse) => {
    if (httpMethod !== "GET") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    if (requestUrl.pathname !== redirectTarget.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    const state = requestUrl.searchParams.get("state"),
      flow = state == null ? undefined : pendingStates.get(state);
    if (state == null || flow == null) {
      response.writeHead(404).end("Not found");
      return;
    }
    const serverName = flow.serverName;
    flow.completing ??= finishFlow(state, flow, requestUrl);
    const outcome = await flow.completing,
      isSuccess = outcome.kind === "success";
    const statusCode = isSuccess ? 200 : outcome.kind === "refused" ? 400 : 500;
    const page =
      isSuccess
        ? renderMcpOAuthSuccessPage({ serverName })
        : renderMcpOAuthErrorPage({ serverName });
    response.writeHead(statusCode, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    response.end(page);
  };
  const onRequest = (incoming: IncomingMessage, response: ServerResponse) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(incoming.url ?? "/", redirectTarget.origin);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    void serveCallback(requestUrl, incoming.method ?? "GET", response);
  };
  const bindMissingListeners = async () => {
    await listenersClosed;
    if (isDisposed || pendingStates.size === 0) return;
    const bindErrors: unknown[] = [];
    for (const address of bindAddresses) {
      if (listeners.has(address)) continue;
      const listenerServer = createServer(onRequest);
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          listenerServer.once("error", onError);
          listenerServer.listen(bindPort, address, () => {
            listenerServer.off("error", onError);
            resolve();
          });
        });
        if (isDisposed || pendingStates.size === 0) listenerServer.close();
        else {
          listenerServer.unref();
          listeners.set(address, listenerServer);
        }
      } catch (error) {
        bindErrors.push(error);
        listenerServer.close();
      }
    }
    if (listeners.size === bindAddresses.length) {
      stopBindTimer();
      if (loggedBindFailure) {
        deps.log("[slate:mcp] loopback OAuth listener bound after retry");
        loggedBindFailure = false;
      }
    } else if (bindErrors.length > 0 && !loggedBindFailure) {
      loggedBindFailure = true;
      deps.log(
        `[slate:mcp] loopback OAuth listener failed to bind port ${bindPort} (retrying while auth is pending): ${bindErrors[0] instanceof Error ? bindErrors[0].message : String(bindErrors[0])}`,
      );
    }
  };
  const ensureListening = async (): Promise<void> => {
    binding ??= bindMissingListeners().finally(() => {
      binding = null;
    });
    await binding;
    if (
      !isDisposed &&
      pendingStates.size > 0 &&
      listeners.size < bindAddresses.length &&
      bindTimer == null
    )
      bindTimer = bindRetry.start(ensureListening);
  };
  return {
    async registerPendingAuthFromUrl({
      authorizationUrl,
      serverName,
    }: {
      authorizationUrl: string;
      serverName?: string;
    }): Promise<boolean> {
      if (isDisposed) return false;
      const authorization = parseMcpOAuthLoopbackAuthorization(
        authorizationUrl,
        redirectUrl,
      );
      if (authorization == null) return false;
      const existing = pendingStates.get(authorization.state);
      if (existing != null) {
        existing.expiry.dispose();
        existing.expiry = pendingExpiry.arm(
          authorization.state,
          () => forgetState(authorization.state),
        );
        if (existing.serverName == null && serverName != null)
          existing.serverName = serverName;
        return true;
      }
      pendingStates.set(authorization.state, {
        serverName,
        expiry: pendingExpiry.arm(
          authorization.state,
          () => forgetState(authorization.state),
        ),
        completing: null,
      });
      await ensureListening();
      return true;
    },
    async dispose(): Promise<void> {
      isDisposed = true;
      for (const flow of pendingStates.values()) flow.expiry.dispose();
      pendingStates.clear();
      stopBindTimer();
      try {
        await binding;
      } catch {}
      const items = [...listeners.values()];
      listeners.clear();
      await closeListening(items);
      await listenersClosed;
    },
  };
}
