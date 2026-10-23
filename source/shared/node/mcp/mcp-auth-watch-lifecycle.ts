/**
 * Watching a connector's authorization while it is pending.
 *
 * What is watched is bounded in time and in how often it asks, and a flow that ends — completed, refused or timed out —
 * is reported once, so a caller is not left waiting on something that already finished.
 */
import {
  DEFAULT_MCP_ACCOUNT_KEY,
  provisionalMcpAccountServerIdentifier,
  stripMarkupAndBoundConnectorError,
} from "../../mcp.ts";
import { isDeadlineExceededConnectError } from "../../connect-errors.ts";
import { brandedEnumOf } from "../../errors/bounded-values.ts";
import { SlateError } from "../../errors/registry.ts";
import {
  createDeadlinePolicy,
  createPollingPolicy,
  realClock,
  type Clock,
  type DeadlinePolicy,
  type PollingPolicy,
} from "../../../host/extensions/scheduling.ts";
import { validateAuthorizationUrl } from "./mcp-catalog-cache.ts";
import {
  normalizeAccountKey,
  type DisplayServer,
} from "./mcp-display-runtime.ts";
import { authWatchKey } from "./mcp-auth-watch.ts";
import { MCP_OAUTH_LOOPBACK_CALLBACK_URL } from "./mcp-oauth-loopback.ts";
import { parseInt32McpServerId, validateMcpServerId } from "./mcp-server-id.ts";
import { reportMcpHostEdgeFailure } from "./mcp-diagnostics.ts";

export const CONNECTOR_AUTH_START_REFUSAL_REASONS = [
  "not_configured",
  "admin_blocked",
  "stdio_unsupported",
  "invalid_auth_url",
  "no_auth_link",
  "unreachable",
] as const;
export const CONNECTOR_AUTH_START_FAILURE_REASONS = [
  "probe_failed",
  "rpc_timeout",
] as const;

/** The named refusals and failures a connector start can be reported with. */
const startRefusalReason = brandedEnumOf(CONNECTOR_AUTH_START_REFUSAL_REASONS, "no_auth_link");
const startFailureReason = brandedEnumOf(CONNECTOR_AUTH_START_FAILURE_REASONS, "probe_failed");

/** What one pending watch remembers while it asks whether the sign-in landed. */
interface Watch {
  serverId: string;
  accountKey: string;
  serverName: string;
  serverIdentifier?: string;
  serverUrl: string;
  requestingAgentId: string | null;
  poll: { dispose(): void };
  suppressFirstPoll: boolean;
  expiresAtMs: number;
  isPolling: boolean;
}

/** The dependencies a lifecycle is built over: the backend, its bounds, and the session's own display of a server. */
interface AuthWatchDependencies {
  backendMcpExec: any;
  authWatchPollIntervalMs: number;
  authWatchTimeoutMs: number;
  authWatchPollTimeoutMs: number;
  resolveDisplayServer(
    id: string,
    options?: { requireFreshRead: boolean },
  ): Promise<DisplayServer | undefined>;
  reload(): Promise<void>;
  onConnectorAuth?(event: Record<string, unknown>): void;
  clock?: Clock;
}

/** A start that was refused before a watch could be made, in the shape the tool answers with. */
interface RefusedStart {
  readonly status: "not-supported";
  readonly serverName: string;
  readonly message: string;
}

export class SlateMcpAuthWatchLifecycle {
  private watches = new Map<string, Watch>();
  private completionObserver: ((completion: any) => void) | null = null;
  private readonly pollDeadline: DeadlinePolicy;
  private readonly pollSchedule: PollingPolicy;
  private readonly time: Clock;

  constructor(private readonly dependencies: AuthWatchDependencies) {
    this.time = dependencies.clock ?? realClock;
    this.pollDeadline = createDeadlinePolicy(this.time, {
      name: "mcp-auth-watch-poll",
      timeoutMs: dependencies.authWatchPollTimeoutMs,
    });
    this.pollSchedule = createPollingPolicy(this.time, {
      name: "mcp-auth-watch",
      intervalMs: dependencies.authWatchPollIntervalMs,
    });
  }

  setAuthCompletionObserver(observer: (completion: any) => void): void {
    this.completionObserver = observer;
  }

  /** Reports that a sign-in could not be started, naming the reason it was refused. */
  private refused(reason: string, serverId: string, serverName?: string): void {
    this.dependencies.onConnectorAuth?.({
      phase: "flow_started",
      outcome: "failed",
      serverId,
      serverName,
      error: SlateError.connectorAuthStartRefused({
        reason: startRefusalReason(reason),
      }),
    });
  }

  /** Reloads the catalog, treating a failed reload as nothing to report here. */
  private async reloadQuietly(): Promise<void> {
    try {
      await this.dependencies.reload();
    } catch {}
  }

  /** Reports a card click, when that is what started the flow. */
  private reportCardClicked(serverId: string, displayServer: DisplayServer | undefined): void {
    this.dependencies.onConnectorAuth?.({
      phase: "card_clicked",
      outcome: "ok",
      serverName: displayServer?.name,
      serverId,
    });
  }

  /** The answer for a server that is not configured, after the refusal has been reported. */
  private notConfiguredStart(serverId: string): any {
    this.refused("not_configured", serverId);
    return { status: "not-configured", serverName: serverId };
  }

  /** Asks once more whether the team policy really blocks this server. */
  private async stillBlockedByAdminPolicy(serverId: string): Promise<boolean> {
    try {
      const fresh = await this.dependencies.resolveDisplayServer(serverId, { requireFreshRead: true });
      return fresh == null || fresh.disabledByTeamAdminPolicy === true;
    } catch {
      return false;
    }
  }

  /** The answer for a server the team admin has blocked. */
  private async adminBlockedStart(serverId: string, displayServer: DisplayServer): Promise<any> {
    const watches = this.clearPendingAuthWatchesForServer(serverId);
    await this.reloadQuietly();
    watches.forEach((watch) => this.notifyWatchCancelled(watch));
    this.refused("admin_blocked", serverId, displayServer.name);
    return {
      status: "not-supported",
      serverName: displayServer.name,
      message:
        "This connector is disabled by your team admin's MCP policy, so it can't be authenticated.",
    };
  }

  /** The answer for a connector that runs on this computer instead of signing in through a browser. */
  private stdioUnsupportedStart(serverId: string, displayServer: DisplayServer): RefusedStart {
    this.refused("stdio_unsupported", serverId, displayServer.name);
    return {
      status: "not-supported",
      serverName: displayServer.name,
      message:
        "This connector runs on Slate's computer and does not use browser sign-in. Configure credentials via its env settings instead.",
    };
  }

  /** The backend's answer to "may this account sign in", or the failure the caller has to see. */
  private async checkAuthStatus(serverId: string, accountKey: string, forceReauth: boolean): Promise<any> {
    return this.dependencies.backendMcpExec.checkAuthStatus({
      serverId: parseInt32McpServerId(serverId),
      accountKey,
      oauthRedirectUri: MCP_OAUTH_LOOPBACK_CALLBACK_URL,
      forceReauth,
    });
  }

  /** Reports a probe that did not answer, naming the kind of failure it was. */
  private reportAuthStartFailure(
    serverId: string,
    displayServer: DisplayServer,
    error: unknown,
  ): void {
    this.dependencies.onConnectorAuth?.({
      phase: "flow_started",
      outcome: "failed",
      serverName: displayServer.name,
      serverId,
      error: SlateError.connectorAuthStartFailed({
        reason: startFailureReason(
          isDeadlineExceededConnectError(error)
            ? "rpc_timeout"
            : "probe_failed",
        ),
      }),
    });
  }

  /** Clears a cancelled watch and reloads first, when a forced sign-in replaced the previous flow. */
  private async failStart(state: string, message: string, context: {
    readonly forceReauth: boolean;
    readonly serverId: string;
    readonly accountKey: string;
    readonly serverName: string;
  }): Promise<any> {
    if (context.forceReauth) {
      this.clearPendingAuthWatchCancelled(context.serverId, context.accountKey);
      await this.dependencies.reload();
    }
    return { status: state, serverName: context.serverName, message };
  }

  /** The account identifier a watch is filed under, taking the stored slot or a provisional one. */
  private watchIdentifier(displayServer: DisplayServer, accountKey: string): string | undefined {
    const stored = displayServer.accounts?.find((slot) => slot.accountKey === accountKey)?.serverIdentifier;
    if (stored != null) return stored;
    if (displayServer.serverIdentifier == null) return undefined;
    return provisionalMcpAccountServerIdentifier(displayServer.serverIdentifier, accountKey);
  }

  async authenticateServer(
    rawId: string,
    rawKey: string = DEFAULT_MCP_ACCOUNT_KEY,
    requestingAgentId: string | null = null,
    forceReauth = false,
    trigger: string | null = null,
  ): Promise<any> {
    const serverId = validateMcpServerId(rawId);
    const accountKey = normalizeAccountKey(rawKey);
    const displayServer = await this.dependencies.resolveDisplayServer(serverId);
    if (trigger === "connector_card") this.reportCardClicked(serverId, displayServer);
    if (displayServer == null) return this.notConfiguredStart(serverId);
    if (displayServer.disabledByTeamAdminPolicy && await this.stillBlockedByAdminPolicy(serverId)) {
      return this.adminBlockedStart(serverId, displayServer);
    }
    if ("command" in displayServer.config) {
      return this.stdioUnsupportedStart(serverId, displayServer);
    }
    let authStatus: any;
    try {
      authStatus = await this.checkAuthStatus(serverId, accountKey, forceReauth);
    } catch (error) {
      this.reportAuthStartFailure(serverId, displayServer, error);
      throw error;
    }
    if (!forceReauth && (authStatus.hasValidToken || (authStatus.isAvailable && !authStatus.requiresAuth))) {
      await this.dependencies.reload();
      return { status: "already-authenticated", serverName: displayServer.name };
    }
    const failure = (state: string, message: string) => this.failStart(state, message, {
      forceReauth,
      serverId,
      accountKey,
      serverName: displayServer.name,
    });
    if (authStatus.requiresAuth && authStatus.authUrl) {
      const authorizationUrl = validateAuthorizationUrl(authStatus.authUrl, displayServer.config.url);
      if (authorizationUrl == null) {
        this.refused("invalid_auth_url", serverId, displayServer.name);
        return failure(
          "not-supported",
          "Only HTTPS authentication URLs are supported unless the MCP server is running on localhost.",
        );
      }
      const serverIdentifier = this.watchIdentifier(displayServer, accountKey);
      this.beginPendingAuthWatch({
        serverId,
        accountKey,
        serverName: displayServer.name,
        ...(serverIdentifier == null ? {} : { serverIdentifier }),
        serverUrl: displayServer.config.url,
        requestingAgentId,
        forceReauth,
      });
      this.dependencies.onConnectorAuth?.({
        phase: "flow_started",
        outcome: "ok",
        serverName: displayServer.name,
        serverId,
        reauth: forceReauth,
      });
      return { status: "started", authorizationUrl, serverName: displayServer.name };
    }
    const detail = stripMarkupAndBoundConnectorError(authStatus.error ?? "");
    if (!authStatus.isAvailable && !authStatus.requiresAuth) {
      this.refused("unreachable", serverId, displayServer.name);
      return failure("unreachable", detail || "The connector reported no details.");
    }
    this.refused("no_auth_link", serverId, displayServer.name);
    return failure("not-supported", detail || "This connector did not provide a sign-in link.");
  }

  beginPendingAuthWatch(
    args: Omit<Watch, "poll" | "suppressFirstPoll" | "expiresAtMs" | "isPolling"> & { forceReauth: boolean },
  ): void {
    const watchKey = authWatchKey(args.serverId, args.accountKey);
    const existing = this.watches.get(watchKey);
    const requestingAgentId = args.requestingAgentId ?? existing?.requestingAgentId ?? null;
    this.clearPendingAuthWatchCancelled(args.serverId, args.accountKey);
    const pendingWatch: Watch = {
      ...args,
      requestingAgentId,
      poll: { dispose() {} },
      suppressFirstPoll: args.forceReauth,
      expiresAtMs: this.time.now() + this.dependencies.authWatchTimeoutMs,
      isPolling: false,
    };
    this.watches.set(watchKey, pendingWatch);
    pendingWatch.poll = this.pollSchedule.start(async () => {
      try {
        await this.pollPendingAuthWatch(watchKey);
      } catch (error) {
        reportMcpHostEdgeFailure("auth-watch-poll", error);
      }
    });
  }

  clearPendingAuthWatch(id: string, key: string): Watch | null {
    const watchKey = authWatchKey(id, key);
    const watch = this.watches.get(watchKey);
    if (watch == null) return null;
    watch.poll.dispose();
    this.watches.delete(watchKey);
    return watch;
  }

  clearPendingAuthWatchCancelled(id: string, key: string): Watch | null {
    const watch = this.clearPendingAuthWatch(id, key);
    if (watch != null) this.reportWatchCancelled(watch);
    return watch;
  }

  /** Tells the connector surface that a pending sign-in was dropped. */
  private reportWatchCancelled(watch: Watch): void {
    this.dependencies.onConnectorAuth?.({
      phase: "token_stored",
      outcome: "cancelled",
      serverName: watch.serverName,
      serverId: watch.serverId,
    });
  }

  notifyWatchCancelled(watch: Watch): void {
    this.notify({
      serverId: watch.serverId,
      accountKey: watch.accountKey,
      serverName: watch.serverName,
      ...(watch.serverIdentifier == null ? {} : { serverIdentifier: watch.serverIdentifier }),
      requestingAgentId: watch.requestingAgentId,
      outcome: "cancelled",
    });
  }

  noteAuthCompletedElsewhere(rawId: string, rawKey: string): string | null {
    let id: string, key: string;
    try {
      id = validateMcpServerId(rawId);
      key = normalizeAccountKey(rawKey);
    } catch {
      return null;
    }
    const watch = this.clearPendingAuthWatch(id, key);
    return watch?.requestingAgentId ?? null;
  }

  clearPendingAuthWatchesForServer(id: string): Watch[] {
    const cleared: Watch[] = [];
    for (const watch of [...this.watches.values()]) {
      if (watch.serverId !== id) continue;
      this.clearPendingAuthWatchCancelled(watch.serverId, watch.accountKey);
      cleared.push(watch);
    }
    return cleared;
  }

  clearAllPendingAuthWatches(): void {
    for (const watch of [...this.watches.values()]) {
      this.clearPendingAuthWatch(watch.serverId, watch.accountKey);
    }
  }

  clearAllPendingAuthWatchesCancelled(): void {
    for (const watch of [...this.watches.values()]) {
      this.clearPendingAuthWatchCancelled(watch.serverId, watch.accountKey);
    }
  }

  /** Reports a watch that outlived its window, as the timeout it ended on. */
  private reportWatchTimeout(watch: Watch): void {
    this.dependencies.onConnectorAuth?.({
      phase: "token_stored",
      outcome: "timeout",
      serverName: watch.serverName,
      serverId: watch.serverId,
      error: SlateError.connectorAuthAbandoned(),
    });
  }

  /** Whether a token for the watch's server and account has landed, within the poll's own deadline. */
  private async tokenLanded(watch: Watch): Promise<boolean> {
    return this.pollDeadline.run(async () => {
      const serverUrl = watch.serverUrl.trim();
      if (serverUrl.length === 0) return false;
      const results = await this.dependencies.backendMcpExec.validateTokens([
        { serverUrl, accountKey: watch.accountKey },
      ]);
      return results.some(
        (item: any) =>
          item.serverUrl === serverUrl &&
          item.accountKey === watch.accountKey &&
          item.hasValidToken,
      );
    });
  }

  /** The server as it is now, and whether reading it failed rather than answering. */
  private async freshDisplayServer(watch: Watch): Promise<{ current: DisplayServer | undefined; failed: boolean }> {
    try {
      const current = await this.pollDeadline.run(() =>
        this.dependencies.resolveDisplayServer(watch.serverId, { requireFreshRead: true }),
      );
      return { current, failed: false };
    } catch {
      return { current: undefined, failed: true };
    }
  }

  /** A landed token belongs to the watch and the server is still usable: announce it and reload. */
  private async completeLandedWatch(watch: Watch, key: string): Promise<void> {
    this.clearPendingAuthWatch(watch.serverId, watch.accountKey);
    this.notify({
      serverId: watch.serverId,
      accountKey: watch.accountKey,
      serverName: watch.serverName,
      ...(watch.serverIdentifier == null ? {} : { serverIdentifier: watch.serverIdentifier }),
      requestingAgentId: watch.requestingAgentId,
    });
    await this.reloadQuietly();
  }

  async pollPendingAuthWatch(key: string): Promise<void> {
    const watch = this.watches.get(key);
    if (watch == null || watch.isPolling) return;
    if (watch.suppressFirstPoll) {
      watch.suppressFirstPoll = false;
      return;
    }
    if (this.time.now() >= watch.expiresAtMs) {
      this.clearPendingAuthWatch(watch.serverId, watch.accountKey);
      this.reportWatchTimeout(watch);
      return;
    }
    watch.isPolling = true;
    try {
      const landed = await this.tokenLanded(watch);
      if (!landed || this.watches.get(key) !== watch) return;
      const { current, failed } = await this.freshDisplayServer(watch);
      if (this.watches.get(key) !== watch) return;
      if (!failed && (current == null || current.disabledByTeamAdminPolicy)) {
        this.clearPendingAuthWatchCancelled(watch.serverId, watch.accountKey);
        await this.reloadQuietly();
        this.notifyWatchCancelled(watch);
        return;
      }
      await this.completeLandedWatch(watch, key);
    } catch {
    } finally {
      watch.isPolling = false;
    }
  }

  /** Hands a finished watch to the session's connector surface, and to whoever asked for completions. */
  private notify(completion: any): void {
    if (completion.outcome !== "cancelled") {
      this.dependencies.onConnectorAuth?.({
        phase: "token_stored",
        outcome: "ok",
        serverName: completion.serverName,
        serverId: completion.serverId,
      });
    }
    try {
      this.completionObserver?.(completion);
    } catch {}
  }
}
