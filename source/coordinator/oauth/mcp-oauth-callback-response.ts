import type { ServerResponse } from "node:http";
import {
  renderMcpOAuthErrorPage,
  renderMcpOAuthSuccessPage,
} from "../../shared/mcp-oauth-callback-page.ts";

const HTML_RESPONSE_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

export function sendMcpOAuthErrorPage(
  response: ServerResponse,
  serverName: string,
  status: 400 | 500,
): void {
  response.writeHead(status, HTML_RESPONSE_HEADERS);
  response.end(renderMcpOAuthErrorPage({ serverName }));
}

export function sendMcpOAuthSuccessPage(
  response: ServerResponse,
  serverName: string,
): void {
  response.writeHead(200, HTML_RESPONSE_HEADERS);
  response.end(renderMcpOAuthSuccessPage({ serverName }));
}
