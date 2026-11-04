/**
 * Forwarding an MCP connector's authorization between the pieces that see it.
 *
 * A connector's flow is carried from wherever it started to whoever can finish it — the box's browser or the host's —
 * and what was completed is reported once, so the same flow is not finished twice.
 */
import { createRealExpiryPolicy, type ExpiryPolicy } from "../../host/extensions/scheduling.ts";
import { errorMessage } from "../../shared/errors/summary.ts";
import { startMcpOAuthCallbackListener, type McpOAuthCallbackPorts } from "./mcp-oauth-callback-listener.ts";
import { McpOAuthLoopbackRegistry, type CoordinatorLogger } from "./mcp-oauth-loopback-registry.ts";

export const MCP_OAUTH_PENDING_TTL_MS = 11 * 60 * 1_000;

function pendingKey(redirectOrigin: string, state: string): string {
  return JSON.stringify([redirectOrigin, state]);
}

interface PendingAuth {
  serverName: string;
  expiry: { dispose(): void };
}

export class OAuthPendingRegistry {
  private readonly pendingByOrigin = new Map<string, Map<string, PendingAuth>>();

  add(redirectOrigin: string, state: string, pendingAuth: PendingAuth): void {
    let stateEntries = this.pendingByOrigin.get(redirectOrigin);
    if (stateEntries == null) { stateEntries = new Map(); this.pendingByOrigin.set(redirectOrigin, stateEntries); }
    stateEntries.set(state, pendingAuth);
  }

  resolve(redirectOrigin: string, state: string): string | undefined {
    return this.pendingByOrigin.get(redirectOrigin)?.get(state)?.serverName;
  }

  remove(redirectOrigin: string, state: string): PendingAuth | undefined {
    const stateEntries = this.pendingByOrigin.get(redirectOrigin);
    const pendingAuth = stateEntries?.get(state);
    if (stateEntries == null || pendingAuth == null) return undefined;
    stateEntries.delete(state);
    if (stateEntries.size === 0) this.pendingByOrigin.delete(redirectOrigin);
    return pendingAuth;
  }

  removeServer(serverName: string): PendingAuth[] {
    const evicted: PendingAuth[] = [];
    for (const [redirectOrigin, stateEntries] of [...this.pendingByOrigin]) {
      for (const [state, pendingAuth] of [...stateEntries]) {
        if (pendingAuth.serverName !== serverName) continue;
        stateEntries.delete(state);
        evicted.push(pendingAuth);
      }
      if (stateEntries.size === 0) this.pendingByOrigin.delete(redirectOrigin);
    }
    return evicted;
  }

  removeAll(): PendingAuth[] {
    const evicted = [...this.pendingByOrigin.values()].flatMap((stateEntries) => [...stateEntries.values()]);
    this.pendingByOrigin.clear();
    return evicted;
  }

  hasPendingFor(redirectOrigin: string): boolean {
    return this.pendingByOrigin.has(redirectOrigin);
  }
}

export interface McpOAuthPendingPayload {
  redirectUrl: string;
  state: string;
  serverName: string;
}

interface CallbackListener { close(): void }
type ListenerStarter = (args: McpOAuthCallbackPorts, registry: McpOAuthLoopbackRegistry) => Promise<CallbackListener>;

export interface McpOAuthForwarderDependencies {
  completion: { completeMcpOAuth(value: { code: string; state: string }): Promise<unknown> };
  log: CoordinatorLogger;
  pendingEvents: { subscribe(callbackListener: (pendingRegistry: McpOAuthPendingPayload) => void): { dispose(): void } };
  pendingExpiry?: ExpiryPolicy;
  startListener?: ListenerStarter;
}

export class McpOAuthForwarder {
  private readonly activeListeners = new Map<string, CallbackListener>();
  private readonly pendingRegistry = new OAuthPendingRegistry();
  private readonly loopbackRegistry: McpOAuthLoopbackRegistry;
  private readonly pendingSubscription: { dispose(): void };
  private readonly completionClient: McpOAuthForwarderDependencies["completion"];
  private readonly logger: CoordinatorLogger;
  private readonly expiryPolicy: ExpiryPolicy;
  private readonly listenerStarter: ListenerStarter;

  constructor(dependencies: McpOAuthForwarderDependencies) {
    this.completionClient = dependencies.completion;
    this.logger = dependencies.log;
    this.expiryPolicy = dependencies.pendingExpiry ?? createRealExpiryPolicy({ name: "mcp-oauth-pending", ttlMs: MCP_OAUTH_PENDING_TTL_MS });
    this.listenerStarter = dependencies.startListener ?? startMcpOAuthCallbackListener;
    this.loopbackRegistry = new McpOAuthLoopbackRegistry(dependencies.log);
    this.pendingSubscription = dependencies.pendingEvents.subscribe((pendingRegistry) => { void this.forwardPending(pendingRegistry); });
  }

  private async forwardPending(pendingPayload: McpOAuthPendingPayload): Promise<void> {
    let redirectOrigin: string;
    try { redirectOrigin = new URL(pendingPayload.redirectUrl).origin; }
    catch (failure) {
      this.logger.warn({ kind: "invalid-redirect-url", serverName: pendingPayload.serverName, detail: errorMessage(failure) });
      return;
    }
    this.trackPending(redirectOrigin, pendingPayload.state, pendingPayload.serverName);
    if (this.activeListeners.has(redirectOrigin)) return;
    try {
      const callbackListener = await this.listenerStarter({
        redirectUrl: pendingPayload.redirectUrl,
        resolve: (state) => {
          const serverName = this.pendingRegistry.resolve(redirectOrigin, state);
          return serverName != null ? { serverName } : undefined;
        },
        onCallback: async ({ code, state }) => { await this.completionClient.completeMcpOAuth({ code, state }); },
        onSettled: (state) => { this.forgetPending(redirectOrigin, state); },
        log: this.logger
      }, this.loopbackRegistry);
      if (this.activeListeners.has(redirectOrigin)) callbackListener.close();
      else { this.activeListeners.set(redirectOrigin, callbackListener); this.closeIdleListeners(); }
    } catch (failure) {
      this.forgetPending(redirectOrigin, pendingPayload.state);
      this.logger.warn({ kind: "listener-start-failed", serverName: pendingPayload.serverName, detail: errorMessage(failure) });
    }
  }

  dispose(): void {
    this.pendingSubscription.dispose();
    for (const callbackListener of this.activeListeners.values()) callbackListener.close();
    this.activeListeners.clear();
    for (const pendingAuth of this.pendingRegistry.removeAll()) pendingAuth.expiry.dispose();
    void this.loopbackRegistry.dispose();
  }

  private trackPending(redirectOrigin: string, state: string, serverName: string): void {
    const superseded = this.pendingRegistry.removeServer(serverName);
    for (const pendingAuth of superseded) pendingAuth.expiry.dispose();
    this.pendingRegistry.remove(redirectOrigin, state)?.expiry.dispose();
    const expiry = this.expiryPolicy.arm(pendingKey(redirectOrigin, state), () => { this.forgetPending(redirectOrigin, state); });
    this.pendingRegistry.add(redirectOrigin, state, { serverName, expiry });
    this.closeIdleListeners();
  }

  private forgetPending(redirectOrigin: string, state: string): void {
    const pendingAuth = this.pendingRegistry.remove(redirectOrigin, state);
    if (pendingAuth == null) return;
    pendingAuth.expiry.dispose();
    this.closeIdleListeners();
  }

  private closeIdleListeners(): void {
    for (const [redirectOrigin, callbackListener] of [...this.activeListeners]) {
      if (this.pendingRegistry.hasPendingFor(redirectOrigin)) continue;
      callbackListener.close();
      this.activeListeners.delete(redirectOrigin);
    }
  }
}
