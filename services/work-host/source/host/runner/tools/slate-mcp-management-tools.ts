/**
 * The tools an agent uses to manage its MCP servers.
 *
 * They list what is installed, add or remove a server and ask for one to be authorized — each naming the server the way
 * the platform files it.
 */
import { z } from "zod";
import { getDefaultMcpCustomInstruction } from "../../../shared/mcp-custom-instructions.ts";
import {
  decodeMcpAccountLabelArgument,
  encodeMcpAccountLabelForListing,
  formatMcpAccountLabelForPrompt,
} from "../../../shared/mcp.ts";
import { isMcpServerId } from "../../../shared/node/mcp/mcp-server-id.ts";
import { defineCommunicateTool } from "./communicate-tool.ts";
import {
  readMcpInstalledListing,
  resolveMcpServerRowByIdentifierOrLegacyId,
  resolveMcpServerRowsByIdentifierOrLegacyId,
} from "./mcp-server-resolution.ts";

export interface McpInstalledServer {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly serverIdentifier: string;
  readonly name: string;
  readonly status: string;
  readonly accountKey: string;
  readonly transport: string;
  readonly toolCount: number;
  readonly disabledToolCount?: number;
  readonly pluginId?: string;
  readonly statusDetail?: string;
  readonly customInstructions: string;
  readonly isTeamServer?: boolean;
}

export interface McpPluginSummary {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly isInstalled: boolean;
  readonly installMode?: string;
  readonly connectorCount: number;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

export interface McpPluginDetail extends McpPluginSummary {
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly isRequired: boolean;
    readonly isSecret: boolean;
  }[];
  readonly servers: readonly McpInstalledServer[];
}

export type McpAuthenticationResult =
  | { readonly kind: "started"; readonly serverName: string }
  | { readonly kind: "already-authenticated"; readonly serverName: string }
  | { readonly kind: "not-configured"; readonly serverName: string }
  | { readonly kind: "not-supported"; readonly serverName: string; readonly message: string }
  | { readonly kind: "unreachable"; readonly serverName: string; readonly message: string };

export interface McpManagementDependencies {
  listPlugins(): Promise<readonly McpPluginSummary[]>;
  getPlugin(pluginId: string): Promise<McpPluginDetail | null>;
  install(input: { readonly id: string; readonly values?: Readonly<Record<string, string>> }): Promise<void>;
  add(input: { readonly name: string; readonly configJson: string }): Promise<readonly McpInstalledServer[]>;
  listInstalled(): Promise<readonly McpInstalledServer[]>;
  removeServer(serverId: string): Promise<{
    readonly removed: boolean;
    readonly reason?: string;
    readonly servers: readonly McpInstalledServer[];
  }>;
  uninstallPlugin(pluginId: string): Promise<{ readonly removed: boolean; readonly reason?: string }>;
  setInstructions(input: { readonly serverId: string; readonly instructions: string }): Promise<readonly McpInstalledServer[]>;
  restart(): Promise<readonly McpInstalledServer[]>;
  authenticate(serverId: string, accountKey: string, requestingAgentId: string | null, forceReauthShape: boolean): Promise<McpAuthenticationResult>;
  removeAccount(input: { readonly serverId: string; readonly accountKey: string }): Promise<readonly McpInstalledServer[]>;
  renameAccount(input: { readonly serverId: string; readonly accountKey: string; readonly newAccountKey: string }): Promise<readonly McpInstalledServer[]>;
}

export interface ConnectorCard {
  readonly connector: string;
  readonly serverId: string;
  readonly variant: "connect" | "connected";
}

export const searchPluginsParameters = z.object({
  query: z.string().trim().optional().describe(
    `Optional. What you're looking for, in natural language (e.g. "manage linear issues" or "write word documents") \u2014 results come back ranked by relevance. Omit to list the whole catalog.`,
  ),
});
export const getPluginParameters = z.object({
  plugin_id: z.string().trim().min(1).describe("The stable plugin id from SearchPlugins."),
});
export const installPluginParameters = z.object({
  plugin_id: z.string().trim().min(1).describe("The stable plugin id from SearchPlugins."),
  values: z.record(z.string(), z.string()).optional().describe(
    `Optional setup values keyed by the plugin's field key from GetPlugin (e.g. { "CONTEXT7_API_KEY": "..." }). Provide every required field. Ask the user for any secret you don't already have.`,
  ),
});
export const addMcpServerParameters = z.object({
  name: z.string().trim().min(1).describe('A short, unique name for the server, e.g. "superpowers".'),
  url: z.string().trim().min(1).describe("The remote server's MCP endpoint URL (https)."),
  headers: z.record(z.string(), z.string()).optional().describe(
    'Optional HTTP headers for the server, e.g. { "Authorization": "Bearer <token>" }. Ask the user for any secret rather than guessing.',
  ),
});

export const PLUGIN_QUERY_MIN_TOKEN_LENGTH = 3;

export function tokenizePluginQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(
    (token) => token.length >= PLUGIN_QUERY_MIN_TOKEN_LENGTH,
  ))];
}

export function scorePluginForToken(plugin: McpPluginSummary, token: string): number {
  const name = plugin.name.toLowerCase();
  const displayName = plugin.displayName.toLowerCase();
  if (name === token || displayName === token) return 8;
  if (name.includes(token) || displayName.includes(token)) return 5;
  if (plugin.skills.some((skill) => skill.name.toLowerCase().includes(token))) return 3;
  if (plugin.category.toLowerCase().includes(token)) return 2;
  if (plugin.description.toLowerCase().includes(token)) return 1;
  return 0;
}

export function rankPluginsLexically<T extends McpPluginSummary>(catalog: readonly T[], query: string): T[] {
  const tokens = tokenizePluginQuery(query);
  const byName = (left: T, right: T): number => left.displayName.localeCompare(right.displayName);
  if (tokens.length === 0) return [...catalog].sort(byName);
  return catalog.map((plugin) => ({
    plugin,
    score: tokens.reduce((sum, token) => sum + scorePluginForToken(plugin, token), 0),
  })).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || byName(left.plugin, right.plugin))
    .map((entry) => entry.plugin);
}

export function validateRemoteMcpUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `"${rawUrl}" is not a valid URL. Ask the user for the server's full https endpoint (e.g. https://example.com/mcp) and try again.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `The server URL must be http(s); "${parsed.protocol}" is not supported. Slate only connects remote http/sse MCP servers over HTTP(S), so ask the user for an https endpoint.`;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return `Don't put credentials in the server URL \u2014 pass them as headers instead (e.g. { "Authorization": "Bearer <token>" }), so they aren't stored in plaintext in the URL. Ask the user for the token and try again with a clean URL.`;
  }
  return null;
}

export function buildServerConfigJson(input: { readonly url?: string | undefined; readonly headers?: Readonly<Record<string, string>> | undefined }): string | null {
  if (input.url == null || input.url.length === 0) return null;
  return JSON.stringify({
    type: "http",
    url: input.url,
    ...(input.headers != null && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
  });
}

export function truncateOneLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export function describeInstalled(server: McpInstalledServer): string {
  const segments = [
    `- ${server.serverIdentifier}: ${server.name} [${server.status}]`,
    `account=${encodeMcpAccountLabelForListing(server.accountKey)}`,
    `transport=${server.transport}`,
    server.disabledToolCount != null && server.disabledToolCount > 0
      ? `tools=${server.toolCount}/${server.toolCount + server.disabledToolCount} enabled`
      : `tools=${server.toolCount}`,
  ];
  if (server.pluginId != null) segments.push(`plugin=${server.pluginId} (remove via UninstallPlugin — removes the whole plugin)`);
  if (server.statusDetail != null && server.statusDetail.length > 0) segments.push(`detail="${truncateOneLine(server.statusDetail, 200)}"`);
  if (server.customInstructions.length > 0 && server.customInstructions !== getDefaultMcpCustomInstruction(server.name)) {
    segments.push(`instructions="${truncateOneLine(server.customInstructions, 120)}"`);
  }
  return segments.join(" · ");
}

export function describeInstalledList(servers: readonly McpInstalledServer[]): string {
  return servers.length === 0
    ? "No MCP servers are installed."
    : [`${servers.length} installed MCP server(s):`, ...servers.map(describeInstalled)].join("\n");
}

function installStateText(plugin: McpPluginSummary): string {
  if (!plugin.isInstalled) return "installed=no";
  return plugin.installMode != null ? `installed=yes (${plugin.installMode})` : "installed=yes";
}

function includesText(plugin: McpPluginSummary): string {
  const segments: string[] = [];
  if (plugin.connectorCount > 0) segments.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? "" : "s"}`);
  if (plugin.skills.length > 0) segments.push(`${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`);
  return segments.length > 0 ? segments.join(", ") : "no primitives";
}

export function describePluginSummary(plugin: McpPluginSummary): string {
  const outcome = [
    `- ${plugin.pluginId}: ${plugin.displayName} \u2014 ${plugin.description}`,
    `  (${[
      installStateText(plugin),
      `includes: ${includesText(plugin)}`,
      `category=${plugin.category}`
    ].join("; ")})`,
  ];
  const hint = getDefaultMcpCustomInstruction(plugin.displayName);
  if (hint.length > 0) outcome.push(`  usage hint: ${hint}`);
  return outcome.join("\n");
}

export function describePluginDetail(detail: McpPluginDetail): string {
  const blocks = [
    `${detail.pluginId}: ${detail.displayName} \u2014 ${detail.description}`,
    `${installStateText(detail)} \xB7 includes: ${includesText(detail)} \xB7 category=${detail.category}`,
  ];
  if (detail.skills.length > 0) {
    blocks.push(["Skills:", ...detail.skills.map((skill) =>
      `  - ${skill.name}${skill.description.length > 0 ? ` \u2014 ${truncateOneLine(skill.description, 140)}` : ""}`,
    )].join("\n"));
  }
  if (detail.fields.length > 0) {
    blocks.push(["Setup fields (pass in InstallPlugin values):", ...detail.fields.map((field) => {
      const tags = [field.isRequired ? "required" : "optional", ...(field.isSecret ? ["secret \u2014 ask the user, never guess"] : [])];
      return `  - ${field.key} (${field.label}; ${tags.join(", ")})`;
    })].join("\n"));
  }
  if (detail.servers.length > 0) blocks.push(["Its installed MCP server(s) — statuses live in GetMcpServerStatus:", ...detail.servers.map(describeInstalled)].join("\n"));
  if (detail.isInstalled && detail.installMode === "team-required") blocks.push("Required by the user's team — it cannot be uninstalled.");
  return blocks.join("\n");
}

export const CARD_SHOWN_NOTE = "Its connect card is now in the chat. Finish unrelated work, then end your turn — you're resumed automatically when the user authorizes. Don't send a link, another card, or reach the service another way meanwhile.";
export const MCP_AWAITING_SELECTION_MESSAGE = "You just sent a question widget, so this turn is waiting on the user's selection — their answer arrives as the next message. Don't install, uninstall, restart, or authenticate an MCP server in the same turn as the confirmation widget; wait for the user to confirm, then do it on your next turn.";

export function newNeedsAuthRows(before: readonly McpInstalledServer[], after: readonly McpInstalledServer[]): Array<{ id: string; name: string }> {
  const previousIds = new Set(before.map((server) => server.serverIdentifier));
  const entries = new Map<string, string>();
  for (const server of after) {
    if (!previousIds.has(server.serverIdentifier) && server.status === "needsAuth") entries.set(server.id, server.name);
  }
  return [...entries].map(([id, name]) => ({ id, name }));
}

export function emitAndDescribeAuthResult(
  outcome: McpAuthenticationResult,
  isForceReauth: boolean,
  serverId: string,
  emitCard?: (card: ConnectorCard) => void,
): string {
  switch (outcome.kind) {
    case "started":
      emitCard?.({ connector: outcome.serverName, serverId, variant: "connect" });
      return isForceReauth
        ? `Signed "${outcome.serverName}" out and started a fresh sign-in. ${CARD_SHOWN_NOTE}`
        : `Authentication started for "${outcome.serverName}". ${CARD_SHOWN_NOTE}`;
    case "already-authenticated":
      emitCard?.({ connector: outcome.serverName, serverId, variant: "connected" });
      return `"${outcome.serverName}" is already authenticated and connected; a confirmation card is now in the chat.`;
    case "not-configured": return `"${outcome.serverName}" is not installed, so there is nothing to authenticate. Install it first.`;
    case "not-supported": return `"${outcome.serverName}" does not support interactive authentication: ${outcome.message}`;
    case "unreachable": return `Sign-in for "${outcome.serverName}" never started. The server or its configuration failed the check: "${outcome.message}" \u2014 not a missing credential, so the user authenticating in Settings would hit the same error. Tell them what it reported instead of sending them to Settings.`;
  }
}

const serverIdShape = z.object({ server_id: z.string().trim().min(1) });
const statusShape = z.object({ server_id: z.string().trim().optional() });
const instructionsShape = serverIdShape.extend({ instructions: z.string() });
const forceReauthShape = z.boolean().optional();
const authShape = serverIdShape.extend({ force_reauth: forceReauthShape });
const multiAuthShape = authShape.extend({ account_label: z.string().trim().min(1) });
const accountShape = serverIdShape.extend({ account_label: z.string().trim().min(1) });
const renameShape = accountShape.extend({ new_account_label: z.string().trim().min(1) });

function missingServerText(token: string): string {
  return `No installed MCP server "${token}". Run GetMcpServerStatus to list every server with its identifier.`;
}

export function createMcpManagementTools(
  host: McpManagementDependencies,
  requestingAgentId?: () => string | undefined,
  isAwaitingSelection?: () => boolean,
  multiAccountEnabled?: () => boolean,
  emitCard?: (card: ConnectorCard) => void,
) {
  const accountsMode = multiAccountEnabled?.() === true;
  const guardWrite = <A>(execute: (ctx: unknown, input: A, services: McpManagementDependencies & { toolCallId: string }) => Promise<string>) =>
    async (ctx: unknown, input: A, services: McpManagementDependencies & { toolCallId: string }): Promise<string> =>
      isAwaitingSelection?.() === true ? MCP_AWAITING_SELECTION_MESSAGE : execute(ctx, input, services);

  const resolveId = async (services: McpManagementDependencies, token: string): Promise<string | null> => {
    const trimmed = token.trim();
    if (isMcpServerId(trimmed)) return trimmed;
    const existing = await readMcpInstalledListing(() => services.listInstalled());
    return existing.kind === "unreadable" ? trimmed : resolveMcpServerRowByIdentifierOrLegacyId(existing.servers, trimmed)?.id ?? null;
  };

  const emitAuthCards = (before: readonly McpInstalledServer[], after: readonly McpInstalledServer[]): string | null => {
    const entries = newNeedsAuthRows(before, after);
    if (entries.length === 0 || emitCard == null) return null;
    for (const row of entries) emitCard({ connector: row.name, serverId: row.id, variant: "connect" });
    return entries.length === 1
      ? `"${entries[0]?.name ?? "Connector"}" needs authentication. ${CARD_SHOWN_NOTE}`
      : `${entries.map((row) => `"${row.name}"`).join(", ")} need authentication. ${CARD_SHOWN_NOTE}`;
  };

  const tools = [
    defineCommunicateTool(host, {
      id: "SEARCH_PLUGINS", name: "SearchPlugins", description: "Search the catalog the user could install (or already has): marketplace catalog bundling connectors and skills. Say what you're looking for in natural language and results come back ranked by relevance, each with its STABLE plugin id, install state, and what it includes. Use this to discover a capability (Linear, Notion, writing Word documents, …) or to check whether a plugin is installed. Inspect one outcome with GetPlugin; connector runtime statuses (connected/needsAuth) live in GetMcpServerStatus. This is read-only and never needs the user's permission.", parameters: searchPluginsParameters,
      execute: async (_ctx, input: z.infer<typeof searchPluginsParameters>, services) => {
        const query = (input.query ?? "").trim();
        const catalog = rankPluginsLexically(await services.listPlugins(), query);
        if (catalog.length === 0) return query.length > 0 ? `No catalog match "${query}".` : "The plugin catalog is empty or unavailable right now.";
        return [`${catalog.length} plugin(s)${query.length > 0 ? ` matching "${query}" (best first)` : " available"}:`, ...catalog.map(describePluginSummary)].join("\n");
      },
    }),
    defineCommunicateTool(host, {
      id: "GET_PLUGIN", name: "GetPlugin", description: "Full detail for one plugin by its STABLE plugin id (from SearchPlugins): what it includes (connectors, skills), its install state, any setup fields InstallPlugin needs (with required/secret tags), and the installed MCP servers backing it. Read this before installing a plugin with setup fields, and before uninstalling (to know the full scope you must disclose). Read-only.", parameters: getPluginParameters,
      execute: async (_ctx, input: z.infer<typeof getPluginParameters>, services) => {
        const detail = await services.getPlugin(input.plugin_id);
        return detail == null ? `No plugin with id "${input.plugin_id}".` : describePluginDetail(detail);
      },
    }),
    defineCommunicateTool(host, {
      id: "INSTALL_PLUGIN", name: "InstallPlugin", description: "Install a plugin by its STABLE plugin id (from SearchPlugins) into the user's Slate account. Only call this after the user has agreed — confirm with a question widget first, since installing changes the user's configuration. Idempotent: re-installing an installed plugin is safe. Pass any setup values GetPlugin lists (ask the user for secrets like API keys — never guess). If an installed connector needs authentication, its connect card is shown to the user automatically — finish unrelated work, then end your turn; you're resumed when they authorize. New tools and skills become available on your next message.", parameters: installPluginParameters,
      execute: guardWrite(async (_ctx, input: z.infer<typeof installPluginParameters>, services) => {
        const before = await services.getPlugin(input.plugin_id);
        if (before == null) return `No plugin with id "${input.plugin_id}".`;
        await services.install({ id: input.plugin_id, ...(input.values == null ? {} : { values: input.values }) });
        const after = await services.getPlugin(input.plugin_id);
        if (after == null || !after.isInstalled) return `The install request for "${before.displayName}" completed, but the plugin does not read as installed yet.`;
        const note = emitAuthCards(before.servers, after.servers);
        return [`Installed ${after.displayName} (plugin ${after.pluginId}).`, ...(note == null ? [] : [note]), describePluginDetail(after)].join("\n");
      }),
    }),
    defineCommunicateTool(host, {
      id: "ADD_MCP_SERVER", name: "AddMcpServer", description: "Add a remote MCP server that isn't in the catalog to the user's Slate account — use this when the user gives you a link for a server that SearchPlugins doesn't know. Only call this after the user agrees to add it — confirm with a question widget first, since it changes the user's account configuration and the server can reach external services on their behalf. Provide the remote server's `url` (with `headers` for any auth token). Slate only supports remote http/sse MCP servers (executed on the backend); local/stdio servers are not supported. Ask the user for the exact endpoint and any secrets rather than guessing; if you only have a link, open it first (WebFetch) to find the connection details. Newly added tools become available to you on your next message.", parameters: addMcpServerParameters,
      execute: guardWrite(async (_ctx, input: z.infer<typeof addMcpServerParameters>, services) => {
        const error = validateRemoteMcpUrl(input.url);
        if (error != null) return error;
        const configJson = buildServerConfigJson(input);
        if (configJson == null) return "A remote MCP URL is required.";
        const before = await services.listInstalled();
        const servers = await services.add({ name: input.name, configJson });
        const note = emitAuthCards(before, servers);
        return [`Added "${input.name}".`, ...(note == null ? [] : [note]), describeInstalledList(servers)].join("\n");
      }),
    }),
    defineCommunicateTool(host, {
      id: "UNINSTALL_MCP_SERVER", name: "UninstallMcpServer", description: "Remove ONE custom MCP server — a server added with AddMcpServer, not one that came from a plugin — by its server identifier. This is destructive and deletes the server with all of its accounts, so confirm with the user via a question widget first. A server the existing marks `plugin=<id>` came from a marketplace plugin: removing it would uninstall that WHOLE plugin, which this tool refuses — use UninstallPlugin for those so the confirmation can disclose the full scope." + (accountsMode ? " To remove just one account and keep the server, use RemoveMcpAccount instead." : ""), parameters: serverIdShape,
      execute: guardWrite(async (_ctx, input: z.infer<typeof serverIdShape>, services) => {
        const installed = await services.listInstalled();
        const row = resolveMcpServerRowByIdentifierOrLegacyId(installed, input.server_id);
        if (row == null) return missingServerText(input.server_id);
        if (row.pluginId != null) return `${row.name} was installed from marketplace plugin ${row.pluginId}; use UninstallPlugin.`;
        if (row.isTeamServer === true) return `${row.name} is provided by the user's team, so it can't be removed here.`;
        const outcome = await services.removeServer(row.id);
        const status = outcome.removed ? `Removed MCP server ${row.name} (${row.serverIdentifier}).` : `The removal request for ${row.name} completed, but it still reads as installed.`;
        return [status, describeInstalledList(outcome.servers)].join("\n");
      }),
    }),
    defineCommunicateTool(host, {
      id: "UNINSTALL_PLUGIN", name: "UninstallPlugin", description: "Uninstall a plugin by its STABLE plugin id (from SearchPlugins). This is destructive and removes the WHOLE PLUGIN — its install record and EVERY connector and skill it added — so confirm with the user via a question widget first, and your confirmation must disclose that full scope (list what goes). Plugins required by the user's team cannot be uninstalled." + (accountsMode ? " This removes each of its servers with ALL of their accounts; to remove just one account from a server, use RemoveMcpAccount instead." : ""), parameters: getPluginParameters,
      execute: guardWrite(async (_ctx, input: z.infer<typeof getPluginParameters>, services) => {
        const detail = await services.getPlugin(input.plugin_id);
        if (detail == null) return `No plugin with id "${input.plugin_id}".`;
        if (!detail.isInstalled) return `${detail.displayName} is not installed — nothing to uninstall.`;
        if (detail.installMode === "team-required") return `${detail.displayName} is required by the user's team and cannot be uninstalled.`;
        const outcome = await services.uninstallPlugin(input.plugin_id);
        return outcome.removed ? `Uninstalled ${detail.displayName} (plugin ${detail.pluginId}).` : `The uninstall request for ${detail.displayName} completed, but it still reads as installed.`;
      }),
    }),
    defineCommunicateTool(host, {
      id: "GET_MCP_SERVER_STATUS", name: "GetMcpServerStatus", description: "The runtime status of the user's installed MCP servers (connected / needsAuth / error, per account). Pass server_id (the server identifier, NEVER a display name) for one server; omit it to list everything. Use this to see which connectors still need authentication, to find the identifier a lifecycle tool needs — the same one GetMcpTools and CallMcpTool address — or to check a connector after installing or authenticating. Read-only and never needs the user's permission.", parameters: statusShape,
      execute: async (_ctx, input: z.infer<typeof statusShape>, services) => {
        const installed = await services.listInstalled();
        const token = input.server_id?.trim();
        if (token == null || token.length === 0) return describeInstalledList(installed);
        const entries = resolveMcpServerRowsByIdentifierOrLegacyId(installed, token);
        return entries.length === 0 ? `No installed MCP server "${token}".` : entries.map(describeInstalled).join("\n");
      },
    }),
    defineCommunicateTool(host, {
      id: "SET_MCP_INSTRUCTIONS", name: "SetMcpInstructions", description: `Set (or clear) an installed connector's custom instructions \u2014 the hint you follow whenever you use that server (e.g. "Reply in threads on Slack"). Use this when the user tells you how they want a connector used, so the preference persists across turns. Pass an empty string to clear it and fall back to the connector's default. This changes a saved preference, not the connection (no OAuth needed); the current value shows in GetMcpServerStatus when it's been customized.`, parameters: instructionsShape,
      execute: guardWrite(async (_ctx, input: z.infer<typeof instructionsShape>, services) => {
        const serverId = await resolveId(services, input.server_id);
        if (serverId == null) return missingServerText(input.server_id);
        const servers = await services.setInstructions({ serverId, instructions: input.instructions });
        return [`${input.instructions.trim().length === 0 ? "Cleared" : "Updated"} custom instructions for MCP server ${input.server_id}.`, describeInstalledList(servers)].join("\n");
      }),
    }),
    defineCommunicateTool(host, {
      id: "RESTART_MCP_SERVERS", name: "RestartMcpServers", description: "Restart (reconnect) the installed MCP servers — useful when a server is stuck, errored, or you just finished authenticating one. Confirm with the user first if a server is mid-task.", parameters: z.object({}),
      execute: guardWrite(async (_ctx, _args: Record<string, never>, services) => ["Restarted MCP servers.", describeInstalledList(await services.restart())].join("\n")),
    }),
  ];

  const authenticate = (parameters: typeof authShape | typeof multiAuthShape) => defineCommunicateTool(host, {
    id: "AUTHENTICATE_MCP_SERVER", name: "AuthenticateMcpServer", description: "Authenticate an installed MCP server that needs it (status needsAuth, or a tool call failing with an auth error). This is the only way to start a connector's auth: its connect card is shown to the user automatically — never compose a card, paste an authorization link, or reach the same service another way while its authorization is pending. The user authorizes in place and you're resumed automatically, so finish unrelated work, then end your turn.", parameters,
    execute: guardWrite(async (_ctx, input: { server_id: string; account_label?: string; force_reauth?: boolean }, services) => {
      const serverId = await resolveId(services, input.server_id);
      if (serverId == null) return missingServerText(input.server_id);
      const account = accountsMode ? decodeMcpAccountLabelArgument(input.account_label ?? "default") : "default";
      const outcome = await services.authenticate(serverId, account, requestingAgentId?.() ?? null, input.force_reauth === true);
      return emitAndDescribeAuthResult(outcome, input.force_reauth === true, serverId, emitCard);
    }),
  });
  tools.push(authenticate(accountsMode ? multiAuthShape : authShape));

  if (accountsMode) {
    tools.push(
      defineCommunicateTool(host, {
        id: "REMOVE_MCP_ACCOUNT", name: "RemoveMcpAccount", description: "Remove ONE account from an MCP server: the account and its credential are deleted, while the server and its other accounts stay. This is destructive — confirm with the user via a question widget before calling it. To remove a whole custom server (every account), use UninstallMcpServer; to remove a server's whole plugin (every connector, skill, and account), use UninstallPlugin.", parameters: accountShape,
        execute: guardWrite(async (_ctx, input: z.infer<typeof accountShape>, services) => {
          const serverId = await resolveId(services, input.server_id);
          if (serverId == null) return missingServerText(input.server_id);
          const accountKey = decodeMcpAccountLabelArgument(input.account_label);
          const servers = await services.removeAccount({ serverId, accountKey });
          return [`Removed account "${formatMcpAccountLabelForPrompt(accountKey)}" from MCP server ${input.server_id}.`, describeInstalledList(servers)].join("\n");
        }),
      }),
      defineCommunicateTool(host, {
        id: "RENAME_MCP_ACCOUNT", name: "RenameMcpAccount", description: "Rename one of an MCP server's accounts (change its label). The account's server identifier changes with the label at the next existing, so after renaming, re-run GetMcpServerStatus (or GetMcpTools) before calling that account's tools again — stale identifiers fail cleanly. Confirm with a question widget first.", parameters: renameShape,
        execute: guardWrite(async (_ctx, input: z.infer<typeof renameShape>, services) => {
          const serverId = await resolveId(services, input.server_id);
          if (serverId == null) return missingServerText(input.server_id);
          const accountKey = decodeMcpAccountLabelArgument(input.account_label);
          const newAccountKey = decodeMcpAccountLabelArgument(input.new_account_label);
          const servers = await services.renameAccount({ serverId, accountKey, newAccountKey });
          return [`Renamed account "${formatMcpAccountLabelForPrompt(accountKey)}" to "${formatMcpAccountLabelForPrompt(newAccountKey)}" on MCP server ${input.server_id}.`, describeInstalledList(servers)].join("\n");
        }),
      }),
    );
  }
  return tools;
}
