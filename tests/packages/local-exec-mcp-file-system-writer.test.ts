import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { McpFileSystemWriter } from "../../source/packages/local-exec/mcp-file-system-writer.ts";
import { createContext } from "../../source/packages/context/context.ts";

const tool = (name: string, clientKey = "server-a", providerIdentifier = "Server A") => ({ toolName: name, name, clientKey, providerIdentifier, description: name + " tool", inputSchema: { type: "object" }, outputSchema: undefined });
const client = (serverName: string, stateKind = "ready", extra: any = {}) => ({
  serverName,
  getState: async () => ({ kind: stateKind }),
  getTools: async () => extra.tools ?? [tool("read"), tool("write")],
  listResources: async () => ({ resources: extra.resources ?? [{ uri: "res://a", name: "a.txt", mimeType: "text/plain" }] }),
  listPrompts: async () => extra.prompts ?? [{ name: "prompt-a", description: "a prompt" }],
  getInstructions: async () => extra.instructions ?? "do things",
});
function lease(extra: any = {}) {
  return {
    onDidChange: () => ({ dispose: () => undefined }),
    getTools: async () => extra.tools ?? [tool("read"), tool("write")],
    getInstructions: async () => extra.instructions ?? [{ serverIdentifier: "server-a", instructions: "server instructions" }],
    getClients: async () => extra.clients ?? { "server-a": client("Server A") },
  };
}
function makeWriter(options: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "writer-test-"));
  const writer = new McpFileSystemWriter(lease(options.lease) as never, dir, { debounceMs: 5, ...options.writer } as never);
  return { writer, dir };
}
async function settle(writer: McpFileSystemWriter) {
  await writer.waitForPendingWrites();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await writer.waitForPendingWrites();
}
const read = (dir: string, ...segments: string[]) => readFileSync(join(dir, ...segments), "utf8");

describe("the MCP catalog as files", () => {
  it("writes a server's catalog through the lease", async () => {
    const { writer, dir } = makeWriter();
    try {
      await settle(writer);
      assert.equal(read(dir, "mcps", "server-a", "INSTRUCTIONS.md"), "server instructions");
      assert.match(readFileSync(join(dir, "mcps", "server-a", "SERVER_METADATA.json"), "utf8"), /"serverName": "Server A"/);
      assert.match(read(dir, "mcps", "server-a", "tools", "read.json"), /"name": "read"/);
      assert.match(read(dir, "mcps", "server-a", "resources", "a_txt.json"), /"uri": "res:\/\/a"/);
      assert.match(read(dir, "mcps", "server-a", "prompts", "prompt-a.json"), /"name": "prompt-a"/);
      const cached = writer.getCachedServerData();
      assert.deepEqual(cached?.map((server) => [server.serverIdentifier, server.status]), [["server-a", "connected"]]);
      const request = await writer.getMcpFileSystemOptions(createContext(), { timeoutMs: 2_000 });
      assert.deepEqual(request?.mcpDescriptors.map((descriptor) => descriptor.serverIdentifier), ["server-a"]);
      assert.deepEqual(readdirSync(join(dir, "mcps")).sort(), ["server-a"]);
    } finally { writer.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("marks a server that needs authentication and adds the auth tool", async () => {
    const { writer, dir } = makeWriter({ lease: { clients: { "server-auth": client("Auth Server", "requires_authentication") } } });
    try {
      await settle(writer);
      assert.match(read(dir, "mcps", "server-auth", "STATUS.md"), /needs authentication/);
      const request = await writer.getMcpFileSystemOptions(createContext(), { timeoutMs: 2_000 });
      assert.deepEqual(request?.mcpDescriptors[0]?.tools.map((definition) => definition.toolName), ["mcp_auth"]);
    } finally { writer.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("writes the error status for an errored server", async () => {
    const { writer, dir } = makeWriter({ lease: { clients: { "server-err": client("Error Server", "error") } } });
    try {
      await settle(writer);
      assert.match(read(dir, "mcps", "server-err", "STATUS.md"), /errored/);
    } finally { writer.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("builds the options from snapshots", async () => {
    const snapshots = [
      { serverIdentifier: "server-a", serverName: "Server A", tools: [{ name: "read" }], resources: [{ uri: "res://a", name: "a.txt" }], prompts: [{ name: "prompt-a" }], instructions: "do things", status: "connected" },
      { serverIdentifier: "server-empty", serverName: "Empty", tools: [], resources: [], prompts: [], status: "connected" },
      { serverIdentifier: "server-auth", serverName: "Auth", tools: [], resources: [], prompts: [], status: "needsAuth" },
    ];
    const dir = mkdtempSync(join(tmpdir(), "writer-snap-"));
    const writer = new McpFileSystemWriter(lease() as never, dir, { debounceMs: 5, snapshotProvider: { getAllSnapshots: async () => snapshots } } as never);
    try {
      const request = await writer.getMcpFileSystemOptions(createContext(), { timeoutMs: 2_000 });
      assert.deepEqual(request?.mcpDescriptors.map((descriptor) => descriptor.serverIdentifier), ["server-a", "server-auth"]);
      assert.deepEqual(request?.mcpDescriptors[1]?.tools.map((definition) => definition.toolName), ["mcp_auth"]);
    } finally { writer.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps one folder when two servers sanitize to the same name", async () => {
    const { writer, dir } = makeWriter({ lease: { clients: { "a b": client("A"), "a_b": client("B") }, tools: [tool("read", "a b", "A"), tool("write", "a_b", "B")] } });
    try {
      await settle(writer);
      assert.deepEqual(readdirSync(join(dir, "mcps")).sort(), ["a_b"]);
    } finally { writer.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("answers nothing after dispose", async () => {
    const { writer, dir } = makeWriter();
    await settle(writer);
    writer.dispose();
    assert.equal(await writer.getMcpFileSystemOptions(createContext()), undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});