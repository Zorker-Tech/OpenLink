/**
 * Waiting for an OAuth flow to come back.
 *
 * The server's authorization page sends the browser back to a loopback address on this machine, so the listener is what
 * the address is bound to: it answers the one request the flow makes, hands the result to whoever started the flow, and
 * then stops listening — with the first result winning, since a flow that is answered twice is answered once.
 */
import { errorMessage } from "../../shared/errors/summary.ts";
import type { ServerResponse } from "node:http";
import type { CoordinatorLogger, McpOAuthLoopbackRegistry } from "./mcp-oauth-loopback-registry.ts";
import type { McpOAuthCallbackListener, McpOAuthCallbackPorts } from "./mcp-oauth-callback-contracts.ts";
import { sendMcpOAuthErrorPage, sendMcpOAuthSuccessPage } from "./mcp-oauth-callback-response.ts";

export type { McpOAuthCallbackPorts } from "./mcp-oauth-callback-contracts.ts";

export async function startMcpOAuthCallbackListener(
  args: McpOAuthCallbackPorts,
  registry: McpOAuthLoopbackRegistry,
): Promise<McpOAuthCallbackListener> {
  const redirectUrl = new URL(args.redirectUrl);
  const release = await registry.acquire(redirectUrl, async (requestUrl, _request, response) => {
    if (requestUrl.pathname !== redirectUrl.pathname) return false;
    const state = requestUrl.searchParams.get("state");
    const pending = state != null ? args.resolve(state) : undefined;
    if (state == null || pending == null) return false;
    const serverName = pending.serverName;
    try {
      const error = requestUrl.searchParams.get("error");
      if (error != null) {
        sendMcpOAuthErrorPage(response as ServerResponse, serverName, 400);
        return true;
      }
      const code = requestUrl.searchParams.get("code");
      if (code == null || code.length === 0) {
        sendMcpOAuthErrorPage(response as ServerResponse, serverName, 400);
        return true;
      }
      await args.onCallback({ code, state });
      sendMcpOAuthSuccessPage(response as ServerResponse, serverName);
      return true;
    } catch (error) {
      sendMcpOAuthErrorPage(response as ServerResponse, serverName, 500);
      args.log.warn({ kind: "callback-forward-failed", detail: errorMessage(error) });
      return true;
    } finally {
      args.onSettled(state);
    }
  });
  return { close() { void release(); } };
}
