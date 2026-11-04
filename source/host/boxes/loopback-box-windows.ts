/** Forked desktop connections, keyed by the agent that owns each display. */
import type { Context } from "../../packages/context/context.ts";
import { BOX_FORK_NOVNC_PORT } from "../../packages/constants/box-endpoints.ts";
import { isPrimaryWindowIndex } from "../ports/box.ts";
import type { BoxWindowShellCommandExecutor } from "./box-window-shell-contract.ts";
import {
  SLATE_BOX_DISPLAY_HEADER,
  SLATE_BOX_FORK_ROUTER_PORT,
  SLATE_BOX_WINDOW_OWNER_HEADER,
  boxDisplayToken,
  boxWindowKey,
  clearAgentWindowConnections,
  primaryBoxWindow,
  runStartWindow,
  runStopWindow,
  type ShellAccessor,
} from "./box-windows.ts";
import type { BoxEndpoint, LoopbackOperations } from "./loopback-box-contracts.ts";

export interface PrimaryBoxConnection<Accessor extends ShellAccessor> {
  remoteAccessor: Accessor;
  vncUrl: string;
  terminalsFolder: string;
}

export interface LoopbackBoxWindowDependencies<Accessor extends ShellAccessor> {
  host: string;
  authToken: string;
  operations: Pick<LoopbackOperations<Accessor>, "ping" | "createRemoteAccessor">;
  executeWindowCommand: BoxWindowShellCommandExecutor;
  ensurePrimary(ctx: Context, agentId: string): Promise<PrimaryBoxConnection<Accessor>>;
  waitUntilReady(ctx: Context, endpoint: BoxEndpoint): Promise<void>;
  protect(accessor: Accessor): Accessor;
}

interface CachedWindow<Accessor extends ShellAccessor> {
  window: { windowIndex: number; computerUse: Accessor; vncUrl: string };
  endpoint: BoxEndpoint;
  ownerToken?: string;
}

export class LoopbackBoxWindows<Accessor extends ShellAccessor> {
  private readonly connections = new Map<string, CachedWindow<Accessor>>();

  constructor(private readonly dependencies: LoopbackBoxWindowDependencies<Accessor>) {}

  async ensureWindow(
    ctx: Context,
    agentId: string,
    windowIndex: number,
    options?: { ownerToken?: string },
  ): Promise<{ windowIndex: number; computerUse: Accessor; vncUrl: string }> {
    if (isPrimaryWindowIndex(windowIndex)) {
      return primaryBoxWindow(await this.dependencies.ensurePrimary(ctx, agentId));
    }

    const ownerToken = options?.ownerToken;
    const key = boxWindowKey(agentId, windowIndex);
    const cached = this.connections.get(key);
    if (cached !== undefined && cached.ownerToken === ownerToken) {
      const ping = await this.dependencies.operations.ping(ctx, cached.endpoint);
      if (ping.outcome === "ok") return cached.window;
    }
    this.connections.delete(key);

    const primary = await this.dependencies.ensurePrimary(ctx, agentId);
    await runStartWindow(
      ctx,
      primary.remoteAccessor,
      this.dependencies.executeWindowCommand,
      windowIndex,
      ownerToken,
    );

    const displayToken = boxDisplayToken(windowIndex);
    const headers: Record<string, string> = { [SLATE_BOX_DISPLAY_HEADER]: displayToken };
    if (ownerToken !== undefined) headers[SLATE_BOX_WINDOW_OWNER_HEADER] = ownerToken;
    const endpoint: BoxEndpoint = {
      host: this.dependencies.host,
      port: SLATE_BOX_FORK_ROUTER_PORT,
      authToken: this.dependencies.authToken,
      headers,
    };
    await this.dependencies.waitUntilReady(ctx, endpoint);

    const window = {
      windowIndex,
      computerUse: this.dependencies.protect(this.dependencies.operations.createRemoteAccessor(endpoint)),
      vncUrl: `http://${this.dependencies.host}:${BOX_FORK_NOVNC_PORT}/vnc.html?path=${encodeURIComponent(`websockify?token=${displayToken}`)}`,
    };
    this.connections.set(key, ownerToken === undefined ? { window, endpoint } : { window, endpoint, ownerToken });
    return window;
  }

  async releaseWindow(ctx: Context, agentId: string, windowIndex: number): Promise<void> {
    if (windowIndex == null || isPrimaryWindowIndex(windowIndex)) return;
    this.connections.delete(boxWindowKey(agentId, windowIndex));
    try {
      const primary = await this.dependencies.ensurePrimary(ctx, agentId);
      await runStopWindow(
        ctx,
        primary.remoteAccessor,
        this.dependencies.executeWindowCommand,
        windowIndex,
      );
    } catch {
      // Releasing a window is best effort because its owner may already have ended.
    }
  }

  hibernate(agentId: string): void {
    clearAgentWindowConnections(this.connections, agentId);
  }
}
