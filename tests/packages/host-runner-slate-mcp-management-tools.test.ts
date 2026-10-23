import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildServerConfigJson,
  createMcpManagementTools,
  describeInstalled,
  describeInstalledList,
  describePluginDetail,
  describePluginSummary,
  emitAndDescribeAuthResult,
  newNeedsAuthRows,
  rankPluginsLexically,
  scorePluginForToken,
  tokenizePluginQuery,
  truncateOneLine,
  validateRemoteMcpUrl,
} from "../../source/host/runner/tools/slate-mcp-management-tools.ts";

const server = (overrides: any = {}) => ({ id: "srv-1", serverIdentifier: "mcp-alpha", name: "Alpha", status: "connected", accountKey: "default", transport: "http", toolCount: 3, customInstructions: "", ...overrides });
const plugin = (overrides: any = {}) => ({ pluginId: "plug-1", name: "linear", displayName: "Linear", description: "Manage linear issues", category: "productivity", isInstalled: false, connectorCount: 1, skills: [{ name: "Issue writing", description: "Write issues" }], ...overrides });

describe("the agent's MCP management tools", () => {
  it("tokenizes and ranks a natural-language query", () => {
    assert.deepEqual(tokenizePluginQuery("Manage Linear issues"), ["manage", "linear", "issues"]);
    assert.deepEqual(tokenizePluginQuery("  a  b  "), []);
    assert.equal(scorePluginForToken(plugin() as never, "linear"), 8);
    assert.equal(scorePluginForToken(plugin() as never, "issues"), 1);
    assert.equal(scorePluginForToken(plugin() as never, "zzz"), 0);
    const ranked = rankPluginsLexically([plugin({ pluginId: "p2", name: "notion", displayName: "Notion", description: "notes", category: "writing", skills: [] }), plugin()] as never, "linear");
    assert.deepEqual(ranked.map((entry: any) => entry.pluginId), ["plug-1"]);
    assert.deepEqual(rankPluginsLexically([plugin({ displayName: "Zed" }), plugin({ pluginId: "p2", displayName: "Alpha" })] as never, "").map((entry: any) => entry.pluginId), ["p2", "plug-1"]);
  });

  it("refuses a remote URL it cannot use", () => {
    assert.equal(validateRemoteMcpUrl("https://example.com/mcp"), null);
    assert.match(validateRemoteMcpUrl("not a url")!, /not a valid URL/);
    assert.match(validateRemoteMcpUrl("ftp://example.com")!, /http\(s\)/);
    assert.match(validateRemoteMcpUrl("https://user:pass@example.com")!, /credentials/);
  });

  it("builds the server config and refuses an empty URL", () => {
    assert.equal(buildServerConfigJson({ url: "" }), null);
    assert.equal(buildServerConfigJson({}), null);
    assert.deepEqual(JSON.parse(buildServerConfigJson({ url: "https://e.com/mcp" })!), { type: "http", url: "https://e.com/mcp" });
    assert.deepEqual(JSON.parse(buildServerConfigJson({ url: "https://e.com", headers: { Authorization: "Bearer x" } })!), { type: "http", url: "https://e.com", headers: { Authorization: "Bearer x" } });
    assert.deepEqual(JSON.parse(buildServerConfigJson({ url: "https://e.com", headers: {} })!), { type: "http", url: "https://e.com" });
  });

  it("flattens a value to one line", () => {
    assert.equal(truncateOneLine("a  b\nc", 10), "a b c");
    assert.equal(truncateOneLine("a very long value here", 8), "a very …");
    assert.equal(truncateOneLine("short", 10), "short");
    assert.equal(truncateOneLine("  ", 3), "");
  });

  it("describes a server the way the model should read it", () => {
    assert.equal(describeInstalled(server() as never), '- mcp-alpha: Alpha [connected] · account="default" · transport=http · tools=3');
    const rich = describeInstalled(server({ disabledToolCount: 2, pluginId: "plug-1", statusDetail: "  slow\nstart ", customInstructions: "be nice" }) as never);
    assert.match(rich, /tools=3\/5 enabled/);
    assert.match(rich, /plugin=plug-1 \(remove via UninstallPlugin — removes the whole plugin\)/);
    assert.match(rich, /detail="slow start"/);
    assert.match(rich, /instructions="be nice"/);
    assert.equal(describeInstalledList([]), "No MCP servers are installed.");
    assert.match(describeInstalledList([server()] as never), /^1 installed MCP server\(s\):/);
  });

  it("describes a plugin and its detail", () => {
    const summary = describePluginSummary(plugin() as never);
    assert.match(summary, /- plug-1: Linear/);
    assert.match(summary, /installed=no/);
    assert.match(summary, /1 connector, 1 skill/);
    const detail = describePluginDetail({ ...plugin(), fields: [{ key: "API_KEY", label: "API key", isRequired: true, isSecret: true }], servers: [server()] } as never);
    assert.match(detail, /Setup fields \(pass in InstallPlugin values\):/);
    assert.match(detail, /API_KEY \(API key; required, secret/);
    assert.match(detail, /Its installed MCP server\(s\)/);
    assert.match(describePluginDetail({ ...plugin(), isInstalled: true, installMode: "team-required", skills: [], fields: [], servers: [] } as never), /Required by the user's team/);
  });

  it("reports only servers that newly need authentication", () => {
    assert.deepEqual(newNeedsAuthRows([server()], [server(), server({ id: "srv-2", serverIdentifier: "mcp-beta", name: "Beta", status: "needsAuth" })] as never), [{ id: "srv-2", name: "Beta" }]);
    assert.deepEqual(newNeedsAuthRows([], [server({ status: "needsAuth" })] as never), [{ id: "srv-1", name: "Alpha" }]);
    assert.deepEqual(newNeedsAuthRows([], [server()] as never), []);
    assert.deepEqual(newNeedsAuthRows([server({ status: "needsAuth" })], [server({ status: "needsAuth" })] as never), [], "a server that was already waiting is not reported again");
  });

  it("explains every authentication outcome", () => {
    assert.match(emitAndDescribeAuthResult({ kind: "started", serverName: "Alpha" }, false, "srv-1"), /Authentication started/);
    assert.match(emitAndDescribeAuthResult({ kind: "started", serverName: "Alpha" }, true, "srv-1"), /Signed "Alpha" out/);
    assert.match(emitAndDescribeAuthResult({ kind: "already-authenticated", serverName: "Alpha" }, false, "srv-1"), /already authenticated/);
    assert.match(emitAndDescribeAuthResult({ kind: "not-configured", serverName: "Alpha" }, false, "srv-1"), /not installed/);
    assert.match(emitAndDescribeAuthResult({ kind: "not-supported", serverName: "Alpha", message: "nope" }, false, "srv-1"), /does not support interactive authentication: nope/);
    assert.match(emitAndDescribeAuthResult({ kind: "unreachable", serverName: "Alpha", message: "boom" }, false, "srv-1"), /never started/);
  });

  it("puts the tools in front of the model, with the account tools only when enabled", () => {
    const shape = (options: any = {}) => (createMcpManagementTools({} as never, () => "agent-1", () => options.awaiting ?? false, () => options.multi ?? false, options.emitCard) as any[]).map((tool) => ({ id: tool.toolIdentifier, name: tool.name, keys: Object.keys(tool.parameters?.jsonSchema?.properties ?? {}) }));
    const base = shape();
    assert.deepEqual(base.map((tool) => tool.id), ["SEARCH_PLUGINS", "GET_PLUGIN", "INSTALL_PLUGIN", "ADD_MCP_SERVER", "UNINSTALL_MCP_SERVER", "UNINSTALL_PLUGIN", "GET_MCP_SERVER_STATUS", "SET_MCP_INSTRUCTIONS", "RESTART_MCP_SERVERS", "AUTHENTICATE_MCP_SERVER"]);
    assert.deepEqual(base[0]?.keys, ["query"]);
    assert.deepEqual(base[1]?.keys, ["plugin_id"]);
    assert.deepEqual(base[2]?.keys, ["plugin_id", "values"]);
    const multi = shape({ multi: true });
    assert.deepEqual(multi.map((tool) => tool.id).slice(-3), ["AUTHENTICATE_MCP_SERVER", "REMOVE_MCP_ACCOUNT", "RENAME_MCP_ACCOUNT"]);
    assert.deepEqual(multi.find((tool) => tool.id === "AUTHENTICATE_MCP_SERVER")?.keys, ["server_id", "force_reauth", "account_label"]);
  });
});
