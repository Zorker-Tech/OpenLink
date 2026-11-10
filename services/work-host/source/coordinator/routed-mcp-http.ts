import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_LOCAL_MCP_REQUEST_CHARS = 1_048_576;

export function isRoutedMcpPost(method: string | undefined, requestPath: string | undefined, secretPath: string): boolean {
  return method === "POST" && requestPath === secretPath;
}

export function replyWithStatus(response: ServerResponse, status: number): void {
  response.writeHead(status).end();
}

export async function readRoutedMcpRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | null> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_LOCAL_MCP_REQUEST_CHARS) {
      replyWithStatus(response, 413);
      return null;
    }
  }
  return body;
}

export function parseRoutedMcpMessage(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

export function writeRoutedMcpResult(response: ServerResponse, id: unknown, result: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
