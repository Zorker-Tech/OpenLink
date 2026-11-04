/**
 * The MCP catalog as files a server can read.
 *
 * MCP servers are configured outside the conversation, so the conversation is given the catalog as files: one folder per
 * server holding its tool definitions, resources, prompts, server metadata, instructions and a status file, written
 * through a staging folder and swapped in so a reader never sees a half-written catalog. Writes are debounced and
 * fingerprinted, so a server whose tools did not change is not rewritten, and a write that is already in flight is
 * waited for rather than started twice. The folder lives under the project the platform manages, and the platform's own
 * home directory carries a managed block in its `.gitignore` that lets the cache be read without being committed.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context } from "../context/context.ts";
import { createContext } from "../context/context.ts";
import { createLogger, loggerKey, type ContextLoggerBackend } from "../context/logging.ts";
import { createSpan } from "../context/telemetry.ts";
import { createCounter, createGauge } from "../metrics/index.ts";
import {
  buildMcpToolFileContent,
  isFullMcpLeaseInvalidation,
  mergeMcpLeaseEvents,
  supportsInteractiveMcpAuth,
  type McpLeaseChangeEvent,
  type McpToolFileLike,
} from "../agent-exec/mcp-operations.ts";
import { sanitizeServerName as safeServerName } from "./mcp.ts";
import type { ToolAnnotations } from "./mcp-tool-annotations.ts";

const loggerBase = createLogger("McpFileSystemWriter");
const MCP_FS_STRUCTURED_LOG_OPT_IN_METADATA_KEY = "mcpFsStructuredLogOptIn";
const MCPS_SUBDIR = "mcps";
const MCP_TOOLS_SUBDIR = "tools";
const SERVER_METADATA_FILENAME = "SERVER_METADATA.json";
const MCP_RESOURCES_SUBDIR = "resources";
const MCP_PROMPTS_SUBDIR = "prompts";
const STAGING_SUFFIX = "~staging";
const PREV_SUFFIX = "~prev";
const INSTRUCTIONS_FILENAME = "INSTRUCTIONS.md";
const STATUS_FILENAME = "STATUS.md";
const MCP_AUTH_TOOL_NAME = "mcp_auth";
const DEFAULT_MCP_AUTH_TOOL_DESCRIPTION = "Authenticate this MCP server so its tools can be used. Call this tool through your MCP tool-calling interface when STATUS.md indicates this server needs authentication.";
const DEFAULT_MCP_ERROR_STATUS_MESSAGE = "The MCP server errored. If this server is important for completing the task, concisely inform the user and ask them to check the MCP status in Slate's Customize page > MCPs; otherwise continue with a different approach.";
const DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE = 'The MCP server needs authentication. Authenticate it by calling the `{authToolName}` tool for server "{serverIdentifier}" through your MCP tool-calling interface using an empty arguments object. If this server is important for completing the task, authenticate it first; otherwise continue with a different approach.';
const DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE_NO_VIRTUAL_TOOL = "This MCP server requires authentication before its tools can be used. Open Slate's Customize page > MCPs, select this server, and use Authenticate/Reopen, or refresh credentials in your MCP configuration (for example, mcp.json), then restart this environment. If this server is not required for the task, continue without it.";
const SLATE_DIR_GITIGNORE_MANAGED_START = "# >>> SLATE MANAGED BLOCK >>>";
const SLATE_DIR_GITIGNORE_MANAGED_END = "# <<< SLATE MANAGED BLOCK <<<";
const SLATE_DIR_GITIGNORE_CONTENT = [
  "# Ignore everything in .slate",
  "*",
  "# Un-ignore projects so we can descend to allowlisted subdirs",
  "!projects/",
  "projects/*",
  "!projects/*/",
  "projects/*/*",
  "# MCP tool descriptors, resources, prompts",
  "!projects/*/mcps/",
  "!projects/*/mcps/**",
  "# Agent transcripts for citation",
  "!projects/*/agent-transcripts/",
  "!projects/*/agent-transcripts/**",
  "# Terminal output files",
  "!projects/*/terminals/",
  "!projects/*/terminals/**",
  "# Conversation notes (shared scratchpad)",
  "!projects/*/agent-notes/",
  "!projects/*/agent-notes/**",
  "# Large tool output files",
  "!projects/*/agent-tools/",
  "!projects/*/agent-tools/**",
  "# Plugin cache (rules, skills, agents)",
  "!plugins/",
  "!plugins/**",
  "# Built-in Slate skills",
  "!skills-cursor/",
  "!skills-cursor/**",
  "# User's personal skills",
  "!skills/",
  "!skills/**",
  "# User's personal slash commands",
  "!commands/",
  "!commands/**",
  "# User's plan files",
  "!plans/",
  "!plans/**",
  "# Subagent state/transcripts",
  "!subagents/",
  "!subagents/**",
  "# User-level cursor rules",
  "!rules/",
  "!rules/**",
].join("\n");
const DEFAULT_DEBOUNCE_MS = 100;
const CLIENT_FETCH_TIMEOUT_MS = 15_000;

const mcpFilesystemDivergence = createCounter("mcp.filesystem.divergence", {
  description: "Divergence detected between MCP lease state and filesystem state",
  labelNames: ["divergence_type", "mcp_source", "configured_servers", "mcp_version"],
});
const mcpFilesystemSyncCheck = createCounter("mcp.filesystem.sync_check", {
  description: "MCP filesystem sync check executed",
  labelNames: ["synced", "mcp_source", "configured_servers", "mcp_version"],
});
const mcpFilesystemSyncExpectedServers = createGauge("mcp.filesystem.sync_check.expected_servers", {
  description: "Number of expected MCP servers at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});
const mcpFilesystemSyncActualServers = createGauge("mcp.filesystem.sync_check.actual_servers", {
  description: "Number of actual MCP servers at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});
const mcpFilesystemSyncServersMissing = createGauge("mcp.filesystem.sync_check.servers_missing", {
  description: "Number of expected MCP servers missing from disk at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});
const mcpFilesystemSyncToolMismatches = createGauge("mcp.filesystem.sync_check.tool_mismatches", {
  description: "Number of MCP servers with tool count mismatches at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});

const logger = {
  debug(context: Context, message: string, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.debug(context, message, structuredLogMetadata(metadata, options));
  },
  info(context: Context, message: string, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.info(context, message, structuredLogMetadata(metadata, options));
  },
  warn(context: Context, message: string, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.warn(context, message, structuredLogMetadata(metadata, options));
  },
  error(context: Context, message: string, error: unknown, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.error(context, message, error, structuredLogMetadata(metadata, options));
  },
};

function structuredLogMetadata(metadata: Readonly<Record<string, unknown>> | undefined, options: { includeStructuredLogs?: boolean } | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!options?.includeStructuredLogs) return metadata;
  return { ...(metadata ?? {}), [MCP_FS_STRUCTURED_LOG_OPT_IN_METADATA_KEY]: true };
}

function bucketForCount(count: number): string {
  if (count === 0) return "0";
  if (count <= 3) return "1-3";
  if (count <= 6) return "4-6";
  if (count <= 10) return "7-10";
  return "11+";
}

async function ensurePlatformGitignore(cursorDir: string): Promise<void> {
  const ignorePath = join(cursorDir, ".gitignore");
  const blockText = `${SLATE_DIR_GITIGNORE_MANAGED_START}\n${SLATE_DIR_GITIGNORE_CONTENT}\n${SLATE_DIR_GITIGNORE_MANAGED_END}\n`;
  await mkdir(cursorDir, { recursive: true });
  let currentText: string | undefined;
  try { currentText = await readFile(ignorePath, "utf-8"); }
  catch (error: unknown) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error; }
  if (currentText === undefined) { await writeFile(ignorePath, blockText); return; }
  const blockStart = currentText.indexOf(SLATE_DIR_GITIGNORE_MANAGED_START);
  const blockEnd = currentText.indexOf(SLATE_DIR_GITIGNORE_MANAGED_END, blockStart + SLATE_DIR_GITIGNORE_MANAGED_START.length);
  if (blockStart !== -1 && blockEnd !== -1) {
    const before = currentText.slice(0, blockStart);
    const after = currentText.slice(blockEnd + SLATE_DIR_GITIGNORE_MANAGED_END.length).replace(/^\n/, "");
    const updatedContent = `${before}${blockText}${after}`;
    if (updatedContent !== currentText) await writeFile(ignorePath, updatedContent);
    return;
  }
  await writeFile(ignorePath, blockText);
}

function orFallbackAfter<Value>(promise: Promise<Value>, fallback: Value, timeoutMs = CLIENT_FETCH_TIMEOUT_MS): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<Value>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function safeFileName(name: string): string { return name.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function validCopyOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
function fillAuthTemplate(template: string, params: { serverIdentifier: string; authToolName: string }): string {
  return template.replace(/\{serverIdentifier\}/g, params.serverIdentifier).replace(/\{authToolName\}/g, params.authToolName);
}
function virtualAuthTool(params: { serverIdentifier: string; serverName: string; plugin?: string | undefined; marketplace?: string | undefined; pluginId?: string | undefined; marketplaceId?: string | undefined; authToolDescription: string }): WriterTool {
  return {
    clientKey: params.serverIdentifier,
    providerIdentifier: params.serverName,
    plugin: params.plugin,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    marketplaceId: params.marketplaceId,
    toolName: MCP_AUTH_TOOL_NAME,
    name: MCP_AUTH_TOOL_NAME,
    description: params.authToolDescription,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}
function statusForState(state: ClientState): ServerStatus {
  switch (state.kind) {
    case "loading": return "initializing";
    case "requires_authentication": return "needsAuth";
    case "ready": return "connected";
    case "error": return "error";
    default: return "disconnected";
  }
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entryValue]) => [key, canonicalValue(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
function canonicalString(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
function sortedByCanonicalJson<Value>(values: readonly Value[]): Value[] {
  return values.map((value) => ({ value, key: canonicalString(value) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map((entry) => entry.value);
}
function fingerprintOfServer(server: WriterServer): string {
  const tools = sortedByCanonicalJson(server.tools.map((tool) => ({ name: tool.toolName, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })));
  const resources = sortedByCanonicalJson(server.resources.map((resource) => ({ uri: resource.uri, name: resource.name, description: resource.description, mimeType: resource.mimeType })));
  const prompts = sortedByCanonicalJson(server.prompts.map((prompt) => ({ name: prompt.name, description: prompt.description, arguments: prompt.arguments })));
  return canonicalString({ id: server.serverIdentifier, name: server.serverName, plugin: server.plugin, marketplace: server.marketplace, pluginId: server.pluginId, marketplaceId: server.marketplaceId, tools, resources, prompts, instructions: server.instructions, status: server.status });
}

function reasonOfRejection(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "rejected" ? result.reason : undefined;
}

type ServerStatus = "initializing" | "needsAuth" | "connected" | "error" | "disconnected";
type ClientState = { readonly kind: "loading" | "requires_authentication" | "ready" | "error"; readonly message?: string };
export interface McpFileSystemClient {
  readonly serverName: string;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
  getState(context: Context): Promise<ClientState>;
  getTools(context: Context): Promise<readonly WriterTool[]>;
  listResources(context: Context): Promise<{ readonly resources: readonly WriterResource[] }>;
  listPrompts(context: Context): Promise<readonly WriterPrompt[]>;
  getInstructions?(context: Context): Promise<string | undefined>;
}
export interface McpFileSystemLease {
  onDidChange(listener: (event: McpLeaseChangeEvent | undefined) => void): { dispose(): void };
  getTools(context: Context): Promise<readonly WriterTool[]>;
  getToolsForServers?(context: Context, serverIdentifiers: readonly string[]): Promise<readonly WriterTool[]>;
  getInstructions(context: Context): Promise<readonly WriterInstruction[]>;
  getClients(context: Context): Promise<Readonly<Record<string, McpFileSystemClient>>>;
  getClient?(context: Context, serverIdentifier: string): Promise<McpFileSystemClient | undefined>;
}
export interface McpFileSystemSnapshotProvider {
  getAllSnapshots(context: Context): Promise<readonly McpFileSystemSnapshot[]>;
}
export interface McpFileSystemSnapshot {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly plugin?: string;
  readonly marketplace?: string;
  readonly pluginId?: string;
  readonly marketplaceId?: string;
  readonly tools: readonly SnapshotTool[];
  readonly resources: readonly WriterResource[];
  readonly prompts: readonly WriterPrompt[];
  readonly instructions?: string;
  readonly status: ServerStatus;
}
interface SnapshotTool { readonly name: string; readonly annotations?: ToolAnnotations }
interface WriterResource { readonly uri: string; readonly name?: string; readonly description?: string; readonly mimeType?: string }
interface WriterPrompt { readonly name: string; readonly description?: string; readonly arguments?: readonly unknown[] }
interface WriterInstruction { readonly serverIdentifier?: string; readonly serverName?: string; readonly instructions?: string }
interface WriterServer {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
  readonly sanitizedId: string;
  readonly folderPath: string;
  tools: WriterTool[];
  readonly resources: WriterResource[];
  readonly prompts: WriterPrompt[];
  instructions?: string | undefined;
  readonly status?: ServerStatus | undefined;
}
interface WriterTool extends McpToolFileLike {
  readonly name: string;
  readonly clientKey: string;
  readonly providerIdentifier: string;
  readonly annotations?: ToolAnnotations;
}
interface WriterOptions {
  readonly debounceMs?: number;
  readonly mcpAuthCopyOverrides?: { readonly authToolDescription?: string; readonly errorStatusMessage?: string; readonly needsAuthStatusMessageWithAuthTool?: string; readonly needsAuthStatusMessageWithoutVirtualTool?: string };
  readonly useDirectClientTools?: boolean;
  readonly getEnabledToolsByServer?: (context: Context) => Promise<Readonly<Record<string, readonly string[]>>>;
  readonly exposeVirtualMcpAuthTool?: boolean;
  readonly alwaysExposeVirtualMcpAuthTool?: boolean;
  readonly snapshotProvider?: McpFileSystemSnapshotProvider;
  readonly mcpVersion?: string;
  readonly onDidWrite?: (descriptorList: readonly McpFileSystemDescriptor[]) => void;
  readonly loggerBackend?: ContextLoggerBackend;
}
export interface McpFileSystemToolDescriptor {
  readonly toolName: string;
  readonly definitionPath: string;
  readonly annotations?: ToolAnnotations;
}
export interface McpFileSystemDescriptor {
  readonly serverIdentifier: string;
  readonly folderPath: string;
  readonly tools: readonly { readonly toolName: string; readonly definitionPath: string }[];
}
export interface McpFileSystemOptionDescriptor {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly folderPath: string;
  readonly plugin?: string;
  readonly marketplace?: string;
  readonly pluginId?: string;
  readonly marketplaceId?: string;
  readonly instructions?: string;
  readonly tools: readonly McpFileSystemToolDescriptor[];
}
export interface McpFileSystemOptions {
  readonly enabled: boolean;
  readonly workspaceProjectDir: string;
  readonly mcpDescriptors: readonly McpFileSystemOptionDescriptor[];
}

export class McpFileSystemWriter {
  static readonly DIVERGENCE_CHECK_COOLDOWN_MS = 10_000;
  private readonly fingerprintsByServer = new Map<string, string>();
  private lastServers: WriterServer[] | undefined;
  private isDisposed = false;
  private hasPendingEvent = false;
  private queuedEvent: McpLeaseChangeEvent | undefined;
  private debounceHandle: ReturnType<typeof setTimeout> | undefined;
  private writeChain: Promise<void> | undefined;
  private readonly leaseSource: McpFileSystemLease;
  private readonly workspaceDir: string;
  private readonly debounceDelay: number;
  private readonly copyOverrides: WriterOptions["mcpAuthCopyOverrides"];
  private readonly useDirectTools: boolean;
  private readonly enabledToolsProvider: WriterOptions["getEnabledToolsByServer"];
  private readonly exposeAuthTool: boolean;
  private readonly alwaysExposeAuthTool: boolean;
  private readonly snapshotSource: McpFileSystemSnapshotProvider | undefined;
  private readonly versionTag: string;
  private readonly writeListener: WriterOptions["onDidWrite"];
  private readonly context: Context;
  private readonly startupCleanup: Promise<void>;
  private changeSubscription: { dispose(): void } | undefined;
  private lastDivergenceAt = 0;

  constructor(leaseSource: McpFileSystemLease, workspaceDir: string, options?: WriterOptions) {
    this.leaseSource = leaseSource;
    this.workspaceDir = workspaceDir;
    this.debounceDelay = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.copyOverrides = options?.mcpAuthCopyOverrides;
    this.useDirectTools = options?.useDirectClientTools ?? false;
    this.enabledToolsProvider = options?.getEnabledToolsByServer;
    this.exposeAuthTool = options?.exposeVirtualMcpAuthTool ?? true;
    this.alwaysExposeAuthTool = options?.alwaysExposeVirtualMcpAuthTool ?? false;
    this.snapshotSource = options?.snapshotProvider;
    this.versionTag = options?.mcpVersion ?? (this.snapshotSource ? "capturedServers" : "v1");
    this.writeListener = options?.onDidWrite;
    this.context = this.getContext(options?.loggerBackend);
    this.startupCleanup = this.sweepStaleStaging(this.context);
    this.changeSubscription = this.leaseSource.onDidChange((event) => {
      logger.info(this.context, "Lease change event received", { serverIdentifiers: event?.serverIdentifiers, reason: event?.reason });
      this.handleLeaseChange(this.context, event);
    });
    logger.info(this.context, "Constructor: scheduling initial write");
    this.scheduleWritePass(this.context);
    this.ensurePlatformGitignore();
  }

  private ensurePlatformGitignore(): void { void ensurePlatformGitignore(join(homedir(), ".slate")).catch((error) => logger.warn(this.context, "Failed to ensure ~/.slate/.gitignore", { error: String(error) })); }
  private async sweepStaleStaging(context: Context): Promise<void> { const logCtx = this.logContextFor(context); const mcpsPath = join(this.workspaceDir, MCPS_SUBDIR); try { const entries = await readdir(mcpsPath); await Promise.allSettled(entries.filter((entry) => entry.endsWith(STAGING_SUFFIX)).map((entry) => rm(join(mcpsPath, entry), { recursive: true, force: true }))); } catch (error) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") logger.error(logCtx, "Error clearing stale mcps staging dirs", error); } }
  private handleLeaseChange(context: Context, event: McpLeaseChangeEvent | undefined): void { if (this.isDisposed) return; const normalizedEvent = event ?? { serverIdentifiers: undefined }; this.queuedEvent = this.hasPendingEvent ? mergeMcpLeaseEvents(this.queuedEvent ?? { serverIdentifiers: undefined }, normalizedEvent) : normalizedEvent; this.hasPendingEvent = true; if (this.debounceHandle !== undefined) clearTimeout(this.debounceHandle); this.debounceHandle = setTimeout(() => { this.debounceHandle = undefined; this.scheduleWritePass(context, this.takeQueuedEvent()); }, this.debounceDelay); }
  private takeQueuedEvent(): McpLeaseChangeEvent | undefined { if (!this.hasPendingEvent) return undefined; const event = this.queuedEvent ?? { serverIdentifiers: undefined }; this.queuedEvent = undefined; this.hasPendingEvent = false; return event; }
  private scheduleWritePass(context: Context, leaseChangeEvent?: McpLeaseChangeEvent): void { const logCtx = this.logContextFor(context); if (this.isDisposed) return; const previousPromise = this.writeChain; this.writeChain = (async () => { if (previousPromise) { try { await previousPromise; } catch (error) { logger.error(logCtx, "Error waiting for previous write", error); } } if (this.isDisposed) return; await this.startupCleanup; if (this.isDisposed) return; await this.fetchAndWriteAll(context, leaseChangeEvent); })(); }
  private getContext(loggerBackend?: ContextLoggerBackend): Context { return loggerBackend === undefined ? createContext() : createContext().with(loggerKey, loggerBackend); }
  private logContextFor(context: Context): Context { return context.with(loggerKey, this.context.get(loggerKey)); }
  private metricTagsFor(labels: Readonly<Record<string, string>>): Record<string, string> { return { ...labels, mcp_version: this.versionTag }; }
  private authToolDescription(): string { return validCopyOverride(this.copyOverrides?.authToolDescription) ?? DEFAULT_MCP_AUTH_TOOL_DESCRIPTION; }
  private authToolWanted(serverIdentifier: string, status: ServerStatus | undefined): boolean { return this.exposeAuthTool && supportsInteractiveMcpAuth(serverIdentifier) && (this.alwaysExposeAuthTool || status === "needsAuth"); }
  private errorStatusText(): string { return validCopyOverride(this.copyOverrides?.errorStatusMessage) ?? DEFAULT_MCP_ERROR_STATUS_MESSAGE; }
  private needsAuthStatusText(serverIdentifier: string): string { return fillAuthTemplate(validCopyOverride(this.copyOverrides?.needsAuthStatusMessageWithAuthTool) ?? DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE, { serverIdentifier, authToolName: MCP_AUTH_TOOL_NAME }); }
  private needsAuthStatusTextForWrite(serverIdentifier: string): string { if (!this.exposeAuthTool || !supportsInteractiveMcpAuth(serverIdentifier)) return validCopyOverride(this.copyOverrides?.needsAuthStatusMessageWithoutVirtualTool) ?? DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE_NO_VIRTUAL_TOOL; return this.needsAuthStatusText(serverIdentifier); }

  private async getToolsForServers(context: Context, serverIdentifiers: readonly string[]): Promise<readonly WriterTool[]> { if (serverIdentifiers.length === 0) return []; const logCtx = this.logContextFor(context); try { if (this.leaseSource.getToolsForServers === undefined) throw new Error("scoped MCP lease tool clientLookup unavailable"); return await this.leaseSource.getToolsForServers(context, serverIdentifiers); } catch (error) { logger.warn(logCtx, `getToolsForServers() threw, falling back to filtered getTools(): ${String(error)}`); const allTools = await this.leaseSource.getTools(context).catch((fallbackError) => { logger.warn(logCtx, `getTools() threw during scoped-tool fallback, defaulting to []: ${String(fallbackError)}`); return []; }); const requested = new Set(serverIdentifiers); return allTools.filter((tool) => requested.has(tool.clientKey)); } }
  private async getEnabledToolsByServer(context: Context): Promise<Readonly<Record<string, readonly string[]>> | undefined> { if (!this.useDirectTools || this.enabledToolsProvider === undefined) return undefined; try { return await this.enabledToolsProvider(context); } catch (error) { logger.warn(this.logContextFor(context), `getEnabledToolsByServer() threw, falling back to raw direct client tool lists: ${String(error)}`); return undefined; } }
  private async fetchClientDataForServer(context: Context, clientKey: string, client: McpFileSystemClient, options?: { fetchInstructions?: boolean }): Promise<ClientData> { const logCtx = this.logContextFor(context); const state = await orFallbackAfter(client.getState(context), { kind: "error" }).then((value) => { if (value.kind === "error" && !("message" in value)) logger.warn(context, `getState() timed out for "${clientKey}", defaulting to error`); return value; }); const reachable = state.kind === "ready" || state.kind === "requires_authentication"; const [clientTools, resources, prompts, instructions] = await Promise.all([reachable && this.useDirectTools ? orFallbackAfter(client.getTools(context), []).then((tools) => { if (tools.length === 0) logger.info(logCtx, `Direct client getTools() returned 0 tools for "${clientKey}" (state=${state.kind})`); return tools; }) : Promise.resolve([] as readonly WriterTool[]), reachable ? orFallbackAfter(client.listResources(context), { resources: [] }) : Promise.resolve({ resources: [] as readonly WriterResource[] }), reachable ? orFallbackAfter(client.listPrompts(context), []) : Promise.resolve([] as readonly WriterPrompt[]), reachable && options?.fetchInstructions && client.getInstructions !== undefined ? orFallbackAfter(client.getInstructions(context), undefined) : Promise.resolve(undefined)]); return { clientKey, serverName: client.serverName, plugin: client.plugin, marketplace: client.marketplace, pluginId: client.pluginId, marketplaceId: client.marketplaceId, clientTools: clientTools.map((tool) => ({ ...tool, clientKey, providerIdentifier: client.serverName, plugin: client.plugin, marketplace: client.marketplace, pluginId: client.pluginId, marketplaceId: client.marketplaceId, toolName: tool.name })), resources: resources.resources.map((resource) => ({ ...resource, serverIdentifier: clientKey, serverName: client.serverName })), prompts: prompts.map((prompt) => ({ ...prompt, serverIdentifier: clientKey, serverName: client.serverName })), instructions, status: statusForState(state) }; }

  private buildServerMap(context: Context, tools: readonly WriterTool[], clientFacts: readonly ClientData[], enabledToolsByServer: Readonly<Record<string, readonly string[]>> | undefined, instructions: readonly WriterInstruction[]): Map<string, WriterServer> { const clientToolsByServer = new Map(clientFacts.map((data) => [data.clientKey, data.clientTools])); const serverFactsMap = new Map<string, WriterServer>(); for (const data of clientFacts) { const sanitizedId = safeServerName(data.clientKey); serverFactsMap.set(data.clientKey, { serverIdentifier: data.clientKey, serverName: data.serverName, plugin: data.plugin, marketplace: data.marketplace, pluginId: data.pluginId, marketplaceId: data.marketplaceId, sanitizedId, folderPath: join(this.workspaceDir, MCPS_SUBDIR, sanitizedId), tools: [], resources: data.resources, prompts: data.prompts, instructions: data.instructions, status: data.status }); } for (const tool of tools) { let serverFacts = serverFactsMap.get(tool.clientKey); if (serverFacts === undefined) { const sanitizedId = safeServerName(tool.clientKey); serverFacts = { serverIdentifier: tool.clientKey, serverName: tool.providerIdentifier, plugin: tool.plugin, marketplace: tool.marketplace, pluginId: tool.pluginId, marketplaceId: tool.marketplaceId, sanitizedId, folderPath: join(this.workspaceDir, MCPS_SUBDIR, sanitizedId), tools: [], resources: [], prompts: [], instructions: undefined, status: undefined }; serverFactsMap.set(tool.clientKey, serverFacts!); } serverFacts!.tools.push(tool); } for (const [key, serverFacts] of serverFactsMap) { if (serverFacts.tools.length === 0) { const fallbackTools = clientToolsByServer.get(key); if (fallbackTools !== undefined && fallbackTools.length > 0) { const enabledToolNames = enabledToolsByServer?.[key]; const filtered = enabledToolNames !== undefined ? fallbackTools.filter((tool) => enabledToolNames.includes(tool.toolName)) : fallbackTools; if (enabledToolNames !== undefined && filtered.length === 0) { logger.info(context, `Skipping direct client tool fallback for "${key}": settings report 0 enabled tools`); continue; } logger.info(context, `Using direct client tool fallback for "${key}": lease had 0 tools, client has ${fallbackTools.length}, writing ${filtered.length}`); serverFacts.tools = [...filtered]; } } } for (const instruction of instructions) { const instructionIdentifier = instruction.serverIdentifier?.trim(); let serverFacts = instructionIdentifier === undefined ? undefined : [...serverFactsMap.values()].find((server) => server.serverIdentifier === instructionIdentifier); if (serverFacts === undefined) { const instructionServerName = instruction.serverName?.trim(); serverFacts = instructionServerName === undefined ? undefined : [...serverFactsMap.values()].find((server) => server.serverName === instructionServerName); } if (serverFacts !== undefined && instruction.instructions) serverFacts.instructions = instruction.instructions; } if (this.exposeAuthTool) { for (const server of serverFactsMap.values()) { if (!this.authToolWanted(server.serverIdentifier, server.status)) continue; if (!server.tools.some((tool) => tool.toolName === MCP_AUTH_TOOL_NAME)) server.tools.push(virtualAuthTool({ serverIdentifier: server.serverIdentifier, serverName: server.serverName, plugin: server.plugin, marketplace: server.marketplace, pluginId: server.pluginId, marketplaceId: server.marketplaceId, authToolDescription: this.authToolDescription() })); } } return serverFactsMap; }
  private serversWorthWriting(context: Context, serverFactsMap: Map<string, WriterServer>): WriterServer[] { const serversToWrite: WriterServer[] = []; const seen = new Set<string>(); for (const server of serverFactsMap.values()) { const hasContent = server.tools.length > 0 || server.resources.length > 0 || server.prompts.length > 0 || Boolean(server.instructions); const shouldWriteEmpty = server.status === "error" || server.status === "needsAuth" || server.status === "initializing"; if (!hasContent && !shouldWriteEmpty) { logger.info(context, `Server "${server.serverIdentifier}" excluded from write: tools=${server.tools.length}, resources=${server.resources.length}, prompts=${server.prompts.length}, hasInstructions=${Boolean(server.instructions)}, status=${server.status}`); continue; } if (seen.has(server.sanitizedId)) { logger.warn(context, `Skipping server "${server.serverIdentifier}" — sanitizedId "${server.sanitizedId}" collides with another server`); continue; } seen.add(server.sanitizedId); serversToWrite.push(server); } return serversToWrite; }
  private mergeRefreshedWithCached(cached: WriterServer, refreshed: WriterServer): WriterServer { const tools = [...refreshed.tools]; if (this.authToolWanted(cached.serverIdentifier, cached.status) && !tools.some((tool) => tool.toolName === MCP_AUTH_TOOL_NAME)) { const cachedAuthTool = cached.tools.find((tool) => tool.toolName === MCP_AUTH_TOOL_NAME); if (cachedAuthTool !== undefined) tools.push(cachedAuthTool); } return { ...cached, ...refreshed, tools, resources: cached.resources, prompts: cached.prompts, instructions: cached.instructions, status: cached.status, plugin: refreshed.plugin ?? cached.plugin, marketplace: refreshed.marketplace ?? cached.marketplace, pluginId: refreshed.pluginId ?? cached.pluginId, marketplaceId: refreshed.marketplaceId ?? cached.marketplaceId }; }

  private async refreshFromLease(context: Context, leaseChangeEvent: McpLeaseChangeEvent): Promise<void> { const logCtx = this.logContextFor(context); const ids = [...new Set(leaseChangeEvent.serverIdentifiers ?? [])]; logger.info(logCtx, `fetchAndWriteAll: refreshing ${ids.length} targeted servers`, { serverIdentifiers: ids }); const tools = await this.getToolsForServers(context, ids); const instructions = await this.leaseSource.getInstructions(context).catch((error) => { logger.warn(logCtx, `getInstructions() threw during scoped refresh, defaulting to []: ${String(error)}`); return []; }); const clientLookups = await Promise.all(ids.map(async (serverIdentifier): Promise<ClientLookup> => { try { if (this.leaseSource.getClient === undefined) return { serverIdentifier, kind: "missing" }; const client = await this.leaseSource.getClient(context, serverIdentifier); return client === undefined ? { serverIdentifier, kind: "missing" } : { serverIdentifier, kind: "client", client }; } catch (error) { logger.warn(logCtx, `getClient("${serverIdentifier}") threw, preserving cached data: ${String(error)}`); return { serverIdentifier, kind: "error", error }; } })); const missing = clientLookups.filter((clientLookup): clientLookup is MissingLookup => clientLookup.kind === "missing").map((clientLookup) => clientLookup.serverIdentifier); let confirmedGone = new Set<string>(); if (missing.length > 0) { const clientsById = await this.leaseSource.getClients(context).catch((error) => { logger.warn(logCtx, `getClients() threw while confirming targeted server removal, preserving cached data: ${String(error)}`); return undefined; }); if (clientsById !== undefined) confirmedGone = new Set(missing.filter((id) => clientsById[id] === undefined)); } const [clientFacts, enabledByName] = await Promise.all([Promise.all(clientLookups.filter((clientLookup): clientLookup is ClientLookupWithClient => clientLookup.kind === "client").map(({ serverIdentifier, client }) => this.fetchClientDataForServer(context, serverIdentifier, client, { fetchInstructions: true }))), this.getEnabledToolsByServer(context)]); const next = new Map((this.lastServers ?? []).map((server) => [server.serverIdentifier, server])); const refreshed = this.buildServerMap(context, tools, clientFacts, enabledByName, instructions); const targeted = new Set(ids); const transient = new Set(clientLookups.filter((clientLookup) => clientLookup.kind === "error" || clientLookup.kind === "missing" && !confirmedGone.has(clientLookup.serverIdentifier)).map((clientLookup) => clientLookup.serverIdentifier)); for (const id of ids) { const cached = next.get(id); const replacement = refreshed.get(id); if (replacement !== undefined) { next.set(id, transient.has(id) && cached !== undefined ? this.mergeRefreshedWithCached(cached, replacement) : replacement); continue; } if (confirmedGone.has(id)) next.delete(id); else logger.warn(logCtx, `refreshFromLease: preserving cached data for "${id}" because targeted refresh returned no replacement`); } const leaseSanitizedIdMap = new Map([...next.values()].map((server) => [server.sanitizedId, server.serverIdentifier])); for (const [id] of this.fingerprintsByServer) if (!targeted.has(id) && !next.has(id)) leaseSanitizedIdMap.set(safeServerName(id), id); const servers = this.serversWorthWriting(context, next); await this.writeServers(context, servers, leaseSanitizedIdMap); this.lastServers = servers; this.notifyWriteListener(servers); }

  private async fetchAndWriteAll(context: Context, leaseChangeEvent?: McpLeaseChangeEvent): Promise<void> { using span = createSpan(context.withName("McpFileSystemWriter.fetchAndWriteAll")); const logCtx = this.logContextFor(context); try { if (this.lastServers !== undefined && leaseChangeEvent !== undefined && !isFullMcpLeaseInvalidation(leaseChangeEvent)) { const ids = [...new Set(leaseChangeEvent.serverIdentifiers ?? [])]; if (ids.length > 0) { await this.refreshFromLease(context, leaseChangeEvent); return; } } const [tools, instructions, clients, enabledByName] = await Promise.all([this.leaseSource.getTools(context).catch((error) => { logger.warn(logCtx, `getTools() threw, defaulting to []: ${String(error)}`); return []; }), this.leaseSource.getInstructions(context).catch(() => []), this.leaseSource.getClients(context).catch((error) => { logger.warn(logCtx, `getClients() threw, defaulting to {}: ${String(error)}`); return {}; }), this.getEnabledToolsByServer(context)]); const clientFacts = await Promise.all(Object.entries(clients).map(([clientKey, client]) => this.fetchClientDataForServer(context, clientKey, client))); const serverFactsMap = this.buildServerMap(context, tools, clientFacts, enabledByName, instructions); const servers = this.serversWorthWriting(context, serverFactsMap); const leaseSanitizedIdMap = new Map([...serverFactsMap.values()].map((server) => [server.sanitizedId, server.serverIdentifier])); await this.writeServers(context, servers, leaseSanitizedIdMap); this.lastServers = servers; this.notifyWriteListener(servers); } catch (error) { logger.error(logCtx, "Error fetching/writing MCP state", error); } }
  private notifyWriteListener(servers: readonly WriterServer[]): void { if (this.writeListener === undefined) return; try { this.writeListener(servers.map((server) => ({ serverIdentifier: server.serverIdentifier, folderPath: server.folderPath, tools: server.tools.map((tool) => ({ toolName: tool.toolName, definitionPath: join(server.folderPath, MCP_TOOLS_SUBDIR, `${safeFileName(tool.toolName)}.json`) })) }))); } catch {} }

  private async writeServers(context: Context, servers: readonly WriterServer[], leaseSanitizedIdMap: ReadonlyMap<string, string>): Promise<void> { using span = createSpan(context.withName("McpFileSystemWriter.writeServers")); const logCtx = this.logContextFor(context); const mcpsPath = join(this.workspaceDir, MCPS_SUBDIR); await mkdir(mcpsPath, { recursive: true }); const newFingerprints = new Map<string, string>(); for (const server of servers) { try { newFingerprints.set(server.serverIdentifier, fingerprintOfServer(server)); } catch (error) { logger.error(logCtx, "Error computing server fingerprint, will force write", error, { serverIdentifier: server.serverIdentifier }); newFingerprints.set(server.serverIdentifier, `__error_${Date.now()}_${Math.random()}`); } } const toWrite = servers.filter((server) => this.fingerprintsByServer.get(server.serverIdentifier) !== newFingerprints.get(server.serverIdentifier)); for (const server of servers) if (!toWrite.includes(server)) { try { await stat(join(mcpsPath, server.sanitizedId)); } catch { toWrite.push(server); } } const toRemove = new Set<string>(); for (const [id] of this.fingerprintsByServer) if (!newFingerprints.has(id)) { const old = this.lastServers?.find((server) => server.serverIdentifier === id); const sanitizedId = old?.sanitizedId ?? safeServerName(id); if (!leaseSanitizedIdMap.has(sanitizedId)) toRemove.add(sanitizedId); else newFingerprints.set(id, this.fingerprintsByServer.get(id)!); } if (this.lastServers === undefined) { try { const entries = await readdir(mcpsPath); const liveEntries = new Set(entries.filter((entry) => !entry.endsWith(STAGING_SUFFIX) && !entry.endsWith(PREV_SUFFIX))); for (const entry of entries) { if (entry.endsWith(STAGING_SUFFIX)) await rm(join(mcpsPath, entry), { recursive: true, force: true }); else if (entry.endsWith(PREV_SUFFIX)) { const liveName = entry.slice(0, -PREV_SUFFIX.length); if (!liveEntries.has(liveName)) { try { await rename(join(mcpsPath, entry), join(mcpsPath, liveName)); liveEntries.add(liveName); } catch { await rm(join(mcpsPath, entry), { recursive: true, force: true }).catch(() => {}); } } else await rm(join(mcpsPath, entry), { recursive: true, force: true }); } } for (const liveEntry of liveEntries) { if (!leaseSanitizedIdMap.has(liveEntry)) toRemove.add(liveEntry); else { const serverIdentifier = leaseSanitizedIdMap.get(liveEntry); if (serverIdentifier !== undefined && !newFingerprints.has(serverIdentifier)) newFingerprints.set(serverIdentifier, `__preserved_${liveEntry}`); } } } catch (error) { logger.error(logCtx, "Error clearing mcps directory", error); } } const toRemoveIds = [...toRemove]; const writeResults = await Promise.allSettled(toWrite.map((server) => this.writeServerSwap(context, server, mcpsPath))); for (let index = 0; index < toWrite.length; index += 1) if (writeResults[index]?.status === "rejected") { const server = toWrite[index]!; const old = this.fingerprintsByServer.get(server.serverIdentifier); if (old === undefined) newFingerprints.delete(server.serverIdentifier); else newFingerprints.set(server.serverIdentifier, old); logger.error(context, "Error writing server directory", reasonOfRejection(writeResults[index]!), { serverIdentifier: server.serverIdentifier, sanitizedId: server.sanitizedId }, { includeStructuredLogs: true }); } const removalResults = await Promise.allSettled(toRemoveIds.map((id) => rm(join(mcpsPath, id), { recursive: true, force: true }))); for (let index = 0; index < removalResults.length; index += 1) if (removalResults[index]?.status === "rejected") logger.error(context, "Error removing server directory", reasonOfRejection(removalResults[index]!), { sanitizedId: toRemoveIds[index] }, { includeStructuredLogs: true }); this.fingerprintsByServer.clear(); for (const [key, value] of newFingerprints) this.fingerprintsByServer.set(key, value); }

  private async writeServerSwap(context: Context, server: WriterServer, mcpsPath: string): Promise<void> { using span = createSpan(context.withName("McpFileSystemWriter.writeServerSwap")); const stagingNameText = `${server.sanitizedId}${STAGING_SUFFIX}`; const previousNameText = `${server.sanitizedId}${PREV_SUFFIX}`; const stagingFolder = join(mcpsPath, stagingNameText); const previousFolder = join(mcpsPath, previousNameText); const liveFolder = join(mcpsPath, server.sanitizedId); await rm(stagingFolder, { recursive: true, force: true }); try { await rename(previousFolder, liveFolder); } catch { await rm(previousFolder, { recursive: true, force: true }); } await this.writeServerFiles(context, server, { basePath: mcpsPath, dirName: stagingNameText }); try { try { await rename(liveFolder, previousFolder); } catch {} await rename(stagingFolder, liveFolder); } catch (error) { logger.error(context, "Per-server swap failed", error, { serverIdentifier: server.serverIdentifier, sanitizedId: server.sanitizedId }, { includeStructuredLogs: true }); try { await rename(previousFolder, liveFolder); } catch {} await rm(stagingFolder, { recursive: true, force: true }); throw error; } await rm(previousFolder, { recursive: true, force: true }).catch(() => {}); }
  private async writeServerFiles(context: Context, server: WriterServer, options: { basePath: string; dirName?: string }): Promise<void> { using span = createSpan(context.withName("McpFileSystemWriter.writeServerFiles")); const serverFolder = join(options.basePath, options.dirName ?? server.sanitizedId); await mkdir(serverFolder, { recursive: true }); if (server.tools.length > 0) { const toolFolder = join(serverFolder, MCP_TOOLS_SUBDIR); await mkdir(toolFolder, { recursive: true }); for (const tool of server.tools) await writeFile(join(toolFolder, `${safeFileName(tool.toolName)}.json`), JSON.stringify(buildMcpToolFileContent(tool), null, 2)); } if (server.resources.length > 0) { const resourceFolder = join(serverFolder, MCP_RESOURCES_SUBDIR); await mkdir(resourceFolder, { recursive: true }); for (const resource of server.resources) await writeFile(join(resourceFolder, `${safeFileName(resource.name || resource.uri.replace(/[^a-zA-Z0-9_-]/g, "_"))}.json`), JSON.stringify({ uri: resource.uri, name: resource.name, description: resource.description, mimeType: resource.mimeType }, null, 2)); } if (server.prompts.length > 0) { const promptFolder = join(serverFolder, MCP_PROMPTS_SUBDIR); await mkdir(promptFolder, { recursive: true }); for (const prompt of server.prompts) await writeFile(join(promptFolder, `${safeFileName(prompt.name)}.json`), JSON.stringify({ name: prompt.name, description: prompt.description, arguments: prompt.arguments }, null, 2)); } if (server.instructions && server.instructions.trim().length > 0) await writeFile(join(serverFolder, INSTRUCTIONS_FILENAME), server.instructions.trim()); if (server.status === "error" || server.status === "needsAuth") await writeFile(join(serverFolder, STATUS_FILENAME), server.status === "error" ? this.errorStatusText() : this.needsAuthStatusTextForWrite(server.serverIdentifier)); await writeFile(join(serverFolder, SERVER_METADATA_FILENAME), JSON.stringify({ serverIdentifier: server.serverIdentifier, serverName: server.serverName }, null, 2)); }

  async getMcpFileSystemOptions(context: Context, options?: { timeoutMs?: number }): Promise<McpFileSystemOptions | undefined> {
    if (this.isDisposed) return undefined
    using span = createSpan(context.withName("McpFileSystemWriter.getMcpFileSystemOptions"))
    const writeTimedOut = await this.settleWrites(context, options?.timeoutMs)
    if (this.snapshotSource !== undefined && !writeTimedOut) return this.optionsFromSnapshots(context)

    const servers = this.lastServers ?? []
    const descriptors: McpFileSystemOptionDescriptor[] = servers.map(server => ({
      serverIdentifier: server.serverIdentifier,
      serverName: server.serverName,
      folderPath: server.folderPath,
      ...(server.plugin === undefined ? {} : { plugin: server.plugin }),
      ...(server.marketplace === undefined ? {} : { marketplace: server.marketplace }),
      ...(server.pluginId === undefined ? {} : { pluginId: server.pluginId }),
      ...(server.marketplaceId === undefined ? {} : { marketplaceId: server.marketplaceId }),
      ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
      tools: server.tools.map(tool => ({
        toolName: tool.toolName,
        definitionPath: join(server.folderPath, MCP_TOOLS_SUBDIR, `${safeFileName(tool.toolName)}.json`),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      })),
    }))
    this.checkDescriptorsVsFilesystem(context, descriptors, "workbench_lease")
    return { enabled: true, workspaceProjectDir: this.workspaceDir, mcpDescriptors: descriptors }
  }
  private async settleWrites(context: Context, timeoutMs?: number): Promise<boolean> { const logCtx = this.logContextFor(context); const hadPendingDebounce = this.debounceHandle !== undefined; if (this.debounceHandle !== undefined) { clearTimeout(this.debounceHandle); this.debounceHandle = undefined; this.scheduleWritePass(context, this.takeQueuedEvent()); } if (hadPendingDebounce) logger.info(logCtx, "getMcpFileSystemOptions force-fired pending debounce"); if (this.writeChain === undefined) return false; if (timeoutMs !== undefined) { let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([this.writeChain, new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]); } catch (error) { logger.error(logCtx, "Error waiting for pending write to complete", error); } finally { if (timer !== undefined) clearTimeout(timer); } if (timedOut) logger.warn(logCtx, `getMcpFileSystemOptions timed out after ${timeoutMs}ms waiting for write; returning stale cache`); return timedOut; } try { await this.writeChain; } catch (error) { logger.error(logCtx, "Error waiting for pending write to complete", error); } return false; }
  private async optionsFromSnapshots(context: Context): Promise<McpFileSystemOptions> {
    using span = createSpan(context.withName("McpFileSystemWriter.optionsFromSnapshots"))
    if (this.snapshotSource === undefined) throw new Error("snapshot provider unavailable")
    const logCtx = this.logContextFor(context)
    const startMs = Date.now()
    const capturedServers = await this.snapshotSource.getAllSnapshots(context)
    const mcpDir = join(this.workspaceDir, MCPS_SUBDIR)
    const descriptors: McpFileSystemOptionDescriptor[] = capturedServers
      .filter(captured => captured.tools.length > 0 || captured.resources.length > 0 || captured.prompts.length > 0 || captured.instructions !== undefined || this.authToolWanted(captured.serverIdentifier, captured.status) || captured.status === "needsAuth" || captured.status === "error")
      .map(captured => {
        const folderPath = join(mcpDir, safeServerName(captured.serverIdentifier))
        const tools: McpFileSystemToolDescriptor[] = captured.tools.map(tool => ({
          toolName: tool.name,
          definitionPath: join(folderPath, MCP_TOOLS_SUBDIR, `${safeFileName(tool.name)}.json`),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        }))
        if (this.authToolWanted(captured.serverIdentifier, captured.status) && !captured.tools.some(tool => tool.name === MCP_AUTH_TOOL_NAME)) {
          tools.push({
            toolName: MCP_AUTH_TOOL_NAME,
            definitionPath: join(folderPath, MCP_TOOLS_SUBDIR, `${safeFileName(MCP_AUTH_TOOL_NAME)}.json`),
          })
        }
        return {
          serverIdentifier: captured.serverIdentifier,
          serverName: captured.serverName,
          folderPath,
          ...(captured.plugin === undefined ? {} : { plugin: captured.plugin }),
          ...(captured.marketplace === undefined ? {} : { marketplace: captured.marketplace }),
          ...(captured.pluginId === undefined ? {} : { pluginId: captured.pluginId }),
          ...(captured.marketplaceId === undefined ? {} : { marketplaceId: captured.marketplaceId }),
          ...(captured.instructions === undefined ? {} : { instructions: captured.instructions }),
          tools,
        }
      })
    const totalToolCount = descriptors.reduce((sum, descriptor) => sum + descriptor.tools.length, 0)
    logger.info(logCtx, `optionsFromSnapshots completed in ${Date.now() - startMs}ms: ${capturedServers.length} snapshots, ${descriptors.length} descriptors, ${totalToolCount} tools`)
    this.checkDescriptorsVsFilesystem(context, descriptors, "captured")
    return { enabled: true, workspaceProjectDir: this.workspaceDir, mcpDescriptors: descriptors }
  }
  async waitForPendingWrites(): Promise<void> { if (this.debounceHandle !== undefined) await new Promise<void>((resolve) => { const checkTimer = (): void => { if (this.debounceHandle === undefined) resolve(); else setTimeout(checkTimer, 10); }; checkTimer(); }); if (this.writeChain !== undefined) { try { await this.writeChain; } catch {} } }
  getCachedServerData(): readonly WriterServer[] | undefined { return this.lastServers; }
  checkDescriptorsVsFilesystem(context: Context, descriptorList: readonly McpFileSystemOptionDescriptor[], source: string): void { const logCtx = this.logContextFor(context); const now = Date.now(); if (now - this.lastDivergenceAt < McpFileSystemWriter.DIVERGENCE_CHECK_COOLDOWN_MS) return; this.lastDivergenceAt = now; void this.checkFilesystemAsync(context, descriptorList, source).catch((error) => logger.warn(logCtx, "Divergence check failed", error)); }
  private async checkFilesystemAsync(context: Context, descriptorList: readonly McpFileSystemOptionDescriptor[], source: string): Promise<void> { const logCtx = this.logContextFor(context); const mcpsPath = join(this.workspaceDir, MCPS_SUBDIR); const expectedServerIds = new Set<string>(); const expectedToolCounts = new Map<string, number>(); for (const descriptor of descriptorList) { const sanitizedId = safeServerName(descriptor.serverIdentifier); expectedServerIds.add(sanitizedId); expectedToolCounts.set(sanitizedId, descriptor.tools.length); } let actualDirs: string[] = []; try { actualDirs = (await readdir(mcpsPath)).filter((entry) => !entry.endsWith(STAGING_SUFFIX) && !entry.endsWith(PREV_SUFFIX)); } catch (error) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error; } const actualServerIds = new Set(actualDirs); let synced = true; let serversMissing = 0; let serversStale = 0; let toolMismatches = 0; const serversBucket = bucketForCount(expectedServerIds.size); for (const expected of expectedServerIds) if (!actualServerIds.has(expected)) { synced = false; serversMissing += 1; mcpFilesystemDivergence.increment(context, 1, this.metricTagsFor({ divergence_type: "server_missing", mcp_source: source, configured_servers: serversBucket })); } for (const actual of actualServerIds) if (!expectedServerIds.has(actual)) { synced = false; serversStale += 1; mcpFilesystemDivergence.increment(context, 1, this.metricTagsFor({ divergence_type: "server_stale", mcp_source: source, configured_servers: serversBucket })); } for (const serverId of expectedServerIds) { if (!actualServerIds.has(serverId)) continue; let actualCount = 0; try { actualCount = (await readdir(join(mcpsPath, serverId, MCP_TOOLS_SUBDIR)).then((files) => files.filter((file) => file.endsWith(".json")).length)); } catch {} if (actualCount !== (expectedToolCounts.get(serverId) ?? 0)) { synced = false; toolMismatches += 1; mcpFilesystemDivergence.increment(context, 1, this.metricTagsFor({ divergence_type: "tool_count_mismatch", mcp_source: source, configured_servers: serversBucket })); } } mcpFilesystemSyncCheck.increment(context, 1, this.metricTagsFor({ synced: String(synced), mcp_source: source, configured_servers: serversBucket })); mcpFilesystemSyncExpectedServers.gauge(context, expectedServerIds.size, this.metricTagsFor({ mcp_source: source })); mcpFilesystemSyncActualServers.gauge(context, actualServerIds.size, this.metricTagsFor({ mcp_source: source })); mcpFilesystemSyncServersMissing.gauge(context, serversMissing, this.metricTagsFor({ mcp_source: source })); mcpFilesystemSyncToolMismatches.gauge(context, toolMismatches, this.metricTagsFor({ mcp_source: source })); logger.info(logCtx, "MCP filesystem sync check", { mcpFileSystemMeta: { synced, expectedServers: expectedServerIds.size, actualServers: actualServerIds.size, serversMissing, serversStale, toolMismatches, source, configuredServers: expectedServerIds.size, bucketForCount: serversBucket } }, { includeStructuredLogs: true }); if (!synced) logger.warn(logCtx, "MCP filesystem divergence summary", { mcpFileSystemMeta: { synced, expectedServers: expectedServerIds.size, actualServers: actualServerIds.size, serversMissing, serversStale, toolMismatches, source, configuredServers: expectedServerIds.size, bucketForCount: serversBucket } }, { includeStructuredLogs: true }); }
  dispose(): void { if (this.isDisposed) return; this.isDisposed = true; if (this.debounceHandle !== undefined) { clearTimeout(this.debounceHandle); this.debounceHandle = undefined; } this.changeSubscription?.dispose(); this.changeSubscription = undefined; this.lastServers = undefined; this.fingerprintsByServer.clear(); }
}

interface ClientData { readonly clientKey: string; readonly serverName: string; readonly plugin?: string | undefined; readonly marketplace?: string | undefined; readonly pluginId?: string | undefined; readonly marketplaceId?: string | undefined; readonly clientTools: WriterTool[]; readonly resources: WriterResource[]; readonly prompts: WriterPrompt[]; readonly instructions?: string | undefined; readonly status: ServerStatus }
type MissingLookup = { readonly serverIdentifier: string; readonly kind: "missing" };
type ClientLookupWithClient = { readonly serverIdentifier: string; readonly kind: "client"; readonly client: McpFileSystemClient };
type ClientLookup = MissingLookup | ClientLookupWithClient | { readonly serverIdentifier: string; readonly kind: "error"; readonly error: unknown };
