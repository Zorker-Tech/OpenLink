/**
 * Finding the MCP tools a turn can call, and handing a call to the side that can run it.
 *
 * Tools are discovered over the servers the surface actually has: HTTP/SSE servers are listed by the backend and stdio
 * servers by the box, both once per server set and kept until they age out, with what was there before served while a
 * new look is in flight. A call goes to the side that owns its server — and a server on neither side is answered with
 * where it could have run rather than a silent failure.
 */
import type { JsonValue } from "@bufbuild/protobuf";
import { errorMessage } from "../../errors/summary.ts";
import {
  formatMcpCustomInstructionToolNote,
  resolveMcpCustomInstruction,
} from "../../mcp-custom-instructions.ts";
import {
  createDeadlinePolicy,
  realClock,
  type DeadlinePolicy,
} from "../../../host/extensions/scheduling.ts";
import { displayRowOwnsIdentifier } from "./mcp-definition-source.ts";
import { SlateMcpConfigError } from "./mcp-config-error.ts";
import { generatedMcpResultFactory } from "./mcp-result-factory.ts";
import {
  reportMcpHostEdgeDegraded,
  reportMcpHostEdgeFailure,
} from "./mcp-diagnostics.ts";
import {
  augmentMcpResultWithSavedImages,
  type McpContentItem,
  type McpResultLike,
  type McpResultFactory,
} from "./mcp-image-assets.ts";
import { toJsonArgs } from "./mcp-validation.ts";

export const MCP_TOOLS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const TOOLS_DISCOVERY_DEADLINE_MS = 120_000;

export interface McpDiscoveryResultFactory extends McpResultFactory {
  error(message: string): McpResultLike;
}

type Tool = { providerIdentifier: string; name: string; toolName: string; description?: string; inputSchema?: JsonValue };
type ToolServer = {
  serverIdentifier: string;
  tools: Tool[];
  toolCount?: number;
};
type CacheResolution = { tools: Tool[]; resolved: string };
type CacheEntry = {
  requested: string;
  promise: Promise<CacheResolution>;
  ready?: { tools: Tool[]; resolved: string; atMs: number };
  stale?: Tool[];
};

export function applyCustomInstructionsToMcpResult<T extends McpResultLike>(
  result: T,
  serverName: string,
  rawInstructions: string,
  factory: McpResultFactory = generatedMcpResultFactory,
): T {
  const instructions = rawInstructions.trim();
  if (instructions.length === 0 || result.result.case !== "success")
    return result;
  const success = result.result.value as { content: McpContentItem[] };
  const note = factory.textItem(
    formatMcpCustomInstructionToolNote(serverName, instructions),
  );
  return factory.success(result, [note, ...success.content]);
}

export function createMcpToolsDiscovery(
  host: any,
  options: {
    boxMcpExec?: any;
    deadline?: DeadlinePolicy;
    resultFactory?: McpDiscoveryResultFactory;
    onConnectorAuth?(event: Record<string, unknown>): void;
    onDiscoveryFailed?(event: Record<string, unknown>): void;
  } = {},
) {
  let boxExec = options.boxMcpExec;
  let lastPushedConfig: string | null = null;
  let everPushed = false;
  let pushChain = Promise.resolve();
  let cacheEntry: CacheEntry | null = null;
  let cacheEpoch = 0;
  let coldWarmScheduled = false;
  const reportedCalls = new Map<string, { ok: boolean; failed: boolean }>();
  const factory = options.resultFactory ?? generatedMcpResultFactory;
  const deadline =
    options.deadline ??
    createDeadlinePolicy(realClock, {
      name: "mcp-tools-discovery",
      timeoutMs: TOOLS_DISCOVERY_DEADLINE_MS,
    });

  function displayRow(identifier: string): any {
    return host
      .lastAccountDisplayConfig()
      ?.servers.find(
        (server: any) =>
          server.serverIdentifier != null &&
          displayRowOwnsIdentifier(
            identifier,
            server.serverIdentifier,
            server.accounts,
          ),
      );
  }

  function reportCall(providerIdentifier: string, ok: boolean): void {
    if (options.onConnectorAuth == null) return;
    const entry = reportedCalls.get(providerIdentifier) ?? {
      ok: false,
      failed: false,
    };
    if (ok ? entry.ok : entry.failed) return;
    if (ok) entry.ok = true;
    else entry.failed = true;
    reportedCalls.set(providerIdentifier, entry);
    const row = displayRow(providerIdentifier);
    options.onConnectorAuth({
      phase: "first_call_ok",
      outcome: ok ? "ok" : "failed",
      serverName: row?.name,
      serverId: row?.id,
    });
  }

  function enabledTools(tools: Tool[]): Tool[] {
    const disabledByServerId = host
      .settingsStore()
      .getMcpDisabledToolsByServerId();
    if (Object.keys(disabledByServerId).length === 0) return tools;
    return tools.filter((tool) => {
      const row = displayRow(tool.providerIdentifier);
      return (
        row == null ||
        !(disabledByServerId[row.id]?.includes(tool.toolName) ?? false)
      );
    });
  }

  function enabledCount(serverId: string, tools: Tool[]): number {
    const disabled = host.settingsStore().getMcpDisabledToolsByServerId()[
      serverId
    ];
    return disabled == null || disabled.length === 0
      ? tools.length
      : tools.filter((tool) => !disabled.includes(tool.toolName)).length;
  }

  const serverSetKey = (serverNames: string[]): string =>
    [...serverNames].sort().join("\0");

  function peekServerNames(): string[] | undefined {
    const httpServerNames = host.definitionSource.peekHttpServerNames();
    if (httpServerNames === undefined) return undefined;
    if (boxExec == null) return httpServerNames;
    return [
      ...httpServerNames,
      ...(host.definitionSource.peekStdioServerNames() ?? []),
    ];
  }

  async function pushBoxServers(): Promise<void> {
    const boxMcpExec = boxExec;
    if (boxMcpExec == null) return;
    const stdioConfigs = await host.definitionSource.getStdioServerConfigs();
    const configJson = JSON.stringify({ mcpServers: stdioConfigs });
    if (configJson === lastPushedConfig) return;
    if (Object.keys(stdioConfigs).length === 0 && !everPushed)
      return;
    const push = pushChain.then(async () => {
      if (configJson === lastPushedConfig) return;
      await boxMcpExec.loadServers(configJson);
      lastPushedConfig = configJson;
      everPushed = true;
    });
    pushChain = push.catch((error) =>
      reportMcpHostEdgeFailure("box-config-push", error),
    );
    await push;
  }

  function toolsForKey(key: string): Tool[] | undefined {
    const entry = cacheEntry;
    if (entry == null) return undefined;
    if (entry.ready?.resolved === key) return entry.ready.tools;
    if (entry.requested === key) return entry.stale;
    return undefined;
  }

  function entryUsable(key: string): boolean {
    const entry = cacheEntry;
    if (entry == null) return false;
    if (entry.ready === undefined) return entry.requested === key;
    return (
      entry.ready.resolved === key &&
      Date.now() - entry.ready.atMs < MCP_TOOLS_CACHE_TTL_MS
    );
  }

  function dropEmptyCache(): void {
    if (cacheEntry?.ready !== undefined) cacheEntry = null;
  }

  async function backendServerNames(): Promise<string[]> {
    const userServers = await host.definitionSource.getUserServerConfigs();
    return Object.entries(userServers)
      .filter(([, config]: [string, any]) => "url" in config)
      .map(([name]) => name);
  }

  async function boxServerNames(): Promise<string[]> {
    return boxExec == null
      ? []
      : Object.keys(await host.definitionSource.getStdioServerConfigs());
  }

  async function httpTools(
    serverIdentifiers: string[],
  ): Promise<Tool[]> {
    if (serverIdentifiers.length === 0) return [];
    const servers = await host.backendMcpExec.listTools(serverIdentifiers);
    if (servers.length === 0) {
      reportMcpHostEdgeDegraded("backend-list-tools", "none_resolved");
      return [];
    }
    return servers.flatMap((server: ToolServer) => server.tools);
  }

  async function boxTools(stdioServerNames: string[]): Promise<Tool[]> {
    const boxMcpExec = boxExec;
    if (boxMcpExec == null) return [];
    if (stdioServerNames.length === 0) {
      try {
        await pushBoxServers();
      } catch (error) {
        reportMcpHostEdgeFailure("box-config-reconcile", error);
      }
      return [];
    }
    await pushBoxServers();
    return (await boxMcpExec.listTools(stdioServerNames)).flatMap(
      (server: ToolServer) => server.tools,
    );
  }

  async function fetchTools(): Promise<CacheResolution> {
    const [httpServerNames, stdioServerNames] = await Promise.all([
      backendServerNames(),
      boxServerNames(),
    ]);
    const resolved = serverSetKey([
      ...httpServerNames,
      ...stdioServerNames,
    ]);
    const [httpResult, boxResult] = await Promise.allSettled([
      httpTools(httpServerNames),
      boxTools(stdioServerNames),
    ]);
    if (httpResult.status === "rejected") throw httpResult.reason;
    if (boxResult.status === "rejected") {
      if (httpServerNames.length === 0) throw boxResult.reason;
      reportMcpHostEdgeFailure("box-list-tools", boxResult.reason);
      return { tools: httpResult.value, resolved };
    }
    return { tools: [...httpResult.value, ...boxResult.value], resolved };
  }

  function resolveTools(): Promise<CacheResolution> {
    return deadline.run(() => fetchTools());
  }

  function beginResolution(
    requested: string,
    carryStale: boolean,
  ): CacheEntry {
    const stale = carryStale
      ? toolsForKey(requested)
      : undefined;
    const startedAtMs = Date.now();
    const entry: CacheEntry = {
      requested,
      promise: resolveTools(),
      ...(stale === undefined ? {} : { stale }),
    };
    cacheEntry = entry;
    void entry.promise.then(
      ({ tools, resolved }) => {
        if (cacheEntry === entry)
          entry.ready = { tools, resolved, atMs: Date.now() };
      },
      (error) => {
        if (cacheEntry === entry) {
          if (entry.stale === undefined) cacheEntry = null;
          else
            entry.ready = {
              tools: entry.stale,
              resolved: entry.requested,
              atMs: 0,
            };
        }
        options.onDiscoveryFailed?.({
          errorClass:
            error instanceof Error
              ? error.name.length > 0
                ? error.name
                : "Error"
              : typeof error,
          elapsedMs: Date.now() - startedAtMs,
          servedStale: stale !== undefined,
        });
      },
    );
    return entry;
  }

  async function getToolsRaw(): Promise<Tool[]> {
    const entry = cacheEntry;
    const serverNames = peekServerNames();
    if (entry != null && entry.ready === undefined) {
      if (
        serverNames !== undefined &&
        entry.stale !== undefined &&
        entry.requested === serverSetKey(serverNames)
      ) {
        return entry.stale;
      }
      return (await entry.promise).tools;
    }
    if (entry?.ready !== undefined && serverNames !== undefined) {
      const key = serverSetKey(serverNames);
      if (entry.ready.resolved === key) {
        if (Date.now() - entry.ready.atMs >= MCP_TOOLS_CACHE_TTL_MS)
          beginResolution(key, true);
        return entry.ready.tools;
      }
    }
    if (serverNames !== undefined) {
      const key = serverSetKey(serverNames);
      return (await beginResolution(key, false).promise).tools;
    }
    return (await resolveTools()).tools;
  }

  async function warmCache(epoch: number): Promise<void> {
    const [httpServerNames, stdioServerNames] = await Promise.all([
      backendServerNames(),
      boxServerNames(),
    ]);
    if (epoch !== cacheEpoch) return;
    const key = serverSetKey([...httpServerNames, ...stdioServerNames]);
    if (key === "") {
      dropEmptyCache();
      return;
    }
    if (!entryUsable(key)) beginResolution(key, false);
  }

  function coldWarm(): void {
    if (coldWarmScheduled) return;
    coldWarmScheduled = true;
    const epoch = cacheEpoch;
    void warmCache(epoch).finally(() => {
      coldWarmScheduled = false;
    });
  }

  async function isHttp(providerIdentifier: string): Promise<boolean> {
    try {
      const echoedRow = host
        .lastAccountDisplayConfig()
        ?.servers.find((server: any) =>
          server.accounts?.some(
            (slot: any) => slot.serverIdentifier === providerIdentifier,
          ),
        );
      if (echoedRow != null) return "url" in echoedRow.config;
      return (
        (await host.definitionSource.getServerUrlForIdentifier(
          providerIdentifier,
        )) !== undefined
      );
    } catch {
      return false;
    }
  }

  async function isStdio(
    providerIdentifier: string,
  ): Promise<boolean> {
    try {
      return (
        providerIdentifier in
        (await host.definitionSource.getStdioServerConfigs())
      );
    } catch {
      return false;
    }
  }

  async function runTool(
    args: any,
    auditIdentity: any,
  ): Promise<McpResultLike> {
    if (await isHttp(args.providerIdentifier)) {
      const result = await host.backendMcpExec.executeTool({
        serverIdentifier: args.providerIdentifier,
        toolName: args.name,
        args: toJsonArgs(args.args),
        toolCallId: args.toolCallId,
        agentId: auditIdentity?.agentId,
      });
      reportCall(args.providerIdentifier, result.result.case !== "error");
      return result;
    }
    const boxMcpExec = boxExec;
    if (
      boxMcpExec != null &&
      (await isStdio(args.providerIdentifier))
    ) {
      try {
        await pushBoxServers();
      } catch (error) {
        return factory.error(
          `Could not load MCP servers onto Slate's computer: ${errorMessage(error)}`,
        );
      }
      return boxMcpExec.executeTool(args);
    }
    return factory.error(
      `MCP server "${args.providerIdentifier}" is not available here. HTTP/SSE servers execute on the backend and stdio servers run on Slate's computer; this server is neither reachable nor supported in this context.`,
    );
  }

  return {
    getTools: async (_ctx?: unknown) =>
      enabledTools(await getToolsRaw()),
    getToolsRaw,
    getToolsForTurnStart: async (_ctx?: unknown) => {
      const serverNames = peekServerNames();
      if (serverNames === undefined) {
        coldWarm();
        return [];
      }
      const key = serverSetKey(serverNames);
      if (key === "") {
        dropEmptyCache();
        return [];
      }
      if (!entryUsable(key)) beginResolution(key, true);
      return enabledTools(toolsForKey(key) ?? []);
    },
    async listBoxServers(
      serverIdentifiers: string[],
      options?: unknown,
    ): Promise<Array<ToolServer & { status: string; statusDetail?: string; toolCount: number }>> {
      const boxMcpExec = boxExec;
      if (boxMcpExec == null)
        throw new SlateMcpConfigError(
          "This surface has no box MCP execution port.",
        );
      await host.definitionSource.ensureConfigLoaded();
      await pushBoxServers();
      const servers: Array<ToolServer & { status: string; statusDetail?: string; toolCount: number }> = await boxMcpExec.listTools(
        serverIdentifiers,
        options,
      );
      return servers.map((server) => {
        const row = displayRow(server.serverIdentifier);
        return row == null || server.tools.length === 0
          ? server
          : { ...server, toolCount: enabledCount(row.id, server.tools) };
      });
    },
    async resolveProviderTransport(
      providerIdentifier: string,
    ): Promise<"http" | "stdio" | "unknown"> {
      if (await isHttp(providerIdentifier)) return "http";
      if (await isStdio(providerIdentifier)) return "stdio";
      return "unknown";
    },
    async executeTool(
      _ctx: unknown,
      args: any,
      auditIdentity: any,
    ): Promise<McpResultLike> {
      const displayServer = displayRow(args.providerIdentifier);
      const displayName = displayServer?.name ?? args.providerIdentifier;
      if (
        displayServer != null &&
        (host
          .settingsStore()
          .getMcpDisabledToolsByServerId()
          [displayServer.id]?.includes(args.toolName) ??
          false)
      ) {
        return factory.error(
          `Tool "${args.toolName}" is disabled for "${displayName}".`,
        );
      }
      const raw = await runTool(args, auditIdentity);
      return applyCustomInstructionsToMcpResult(
        raw,
        displayName,
        resolveMcpCustomInstruction(
          displayName,
          host
            .settingsStore()
            .getRawMcpCustomInstructionByServerId(displayServer?.id ?? "") ??
            host.settingsStore().getRawMcpCustomInstruction(displayName),
        ),
        factory,
      );
    },
    setBoxMcpExec(next: any): void {
      boxExec = next;
      lastPushedConfig = null;
      cacheEntry = null;
      reportedCalls.clear();
      cacheEpoch += 1;
      void warmCache(cacheEpoch).catch(() => {});
    },
    invalidateToolsCache(): void {
      const epoch = ++cacheEpoch;
      cacheEntry = null;
      reportedCalls.clear();
      void warmCache(epoch).catch(() => {});
    },
    resetPushState(): void {
      lastPushedConfig = null;
    },
    isBoxExecWired: (): boolean => boxExec != null,
  };
}

export class SlateMcpExecutor {
  constructor(
    private readonly discovery: any,
    private readonly persistImage?: any,
    private readonly spillLargeText?: any,
    private readonly auditIdentity?: any,
    private readonly factory?: McpResultFactory,
  ) {}

  async execute(ctx: unknown, args: unknown): Promise<unknown> {
    const result = await this.discovery.executeTool(
      ctx,
      args,
      this.auditIdentity,
    );
    const spilled =
      this.spillLargeText == null
        ? result
        : await this.spillLargeText(ctx, result);
    if (this.persistImage == null) return spilled;
    return augmentMcpResultWithSavedImages(
      spilled,
      this.persistImage,
      this.factory,
    );
  }
}
