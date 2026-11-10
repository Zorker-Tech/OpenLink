/** A loopback JSON-RPC adapter for the routed tools a session may call. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { projectRoutedMcpResult } from "./routed-mcp-result-projection.ts";
import { isRoutedMcpPost, parseRoutedMcpMessage, readRoutedMcpRequestBody, replyWithStatus, writeRoutedMcpResult } from "./routed-mcp-http.ts";
import { describeRoutedMcpTools, routedMcpTools } from "./routed-mcp-tool-policy.ts";
import { routedMcpRecord } from "./routed-mcp-shapes.ts";
import type { RoutedMcpBridge, RoutedMcpBridgeDependencies, RoutedMcpTool } from "./routed-mcp-bridge-contracts.ts";

export async function createRoutedMcpBridge(deps: RoutedMcpBridgeDependencies): Promise<RoutedMcpBridge> {
  const secretPath = `/mcp/${randomUUID()}`;
  let availableTools = new Map<string, RoutedMcpTool>();

  const server = createServer(async (request, response) => {
    if (!isRoutedMcpPost(request.method, request.url, secretPath)) {
      replyWithStatus(response, 404);
      return;
    }

    const body = await readRoutedMcpRequestBody(request, response);
    if (body === null) return;

    let message: Record<string, unknown>;
    try {
      message = parseRoutedMcpMessage(body);
    } catch {
      replyWithStatus(response, 400);
      return;
    }

    if (message.method === "notifications/initialized") {
      replyWithStatus(response, 202);
      return;
    }

    const reply = (result: unknown): void => writeRoutedMcpResult(response, message.id, result);
    try {
      if (message.method === "initialize") {
        reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "slate-plugins", version: "1" },
        });
        return;
      }

      if (message.method === "tools/list") {
        availableTools = routedMcpTools(await deps.listTools());
        reply({ tools: describeRoutedMcpTools(availableTools.values()) });
        return;
      }

      if (message.method === "tools/call") {
        const parameters = routedMcpRecord(message.params);
        const requestedName = parameters?.name;
        const selectedTool = typeof requestedName === "string" ? availableTools.get(requestedName) : undefined;
        if (selectedTool == null) {
          reply({
            isError: true,
            content: [{ type: "text", text: `Unknown Slate plugin tool: ${String(requestedName)}` }],
          });
          return;
        }

        const result = await deps.callTool({
          ...selectedTool,
          args: parameters?.arguments ?? {},
          toolCallId: randomUUID(),
        });
        reply(projectRoutedMcpResult(result));
        return;
      }

      reply({});
    } catch (error) {
      reply({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the routed MCP bridge");
  return {
    url: `http://127.0.0.1:${address.port}${secretPath}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error == null ? resolve() : reject(error));
    }),
  };
}
