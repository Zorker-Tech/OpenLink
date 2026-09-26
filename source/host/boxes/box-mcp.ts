/**
 * Loading MCP servers into a box.
 *
 * The configuration travels over the box's control connection, and a box whose image predates MCP support answers
 * unimplemented — which is reported as an image that needs updating rather than as a failure of the servers themselves.
 */
import type { Context } from "../../packages/context/context.ts";

export const BOX_MCP_UNSUPPORTED_MESSAGE = "Slate's computer is running an older image without MCP support — update it from Settings → Updates → Update Slate's Computer.";
export class SlateBoxMcpUnsupportedError extends Error { constructor(message = BOX_MCP_UNSUPPORTED_MESSAGE, options?: ErrorOptions) { super(message, options); this.name = "SlateBoxMcpUnsupportedError"; } }
export interface BoxMcpControlClient { loadMcpServers(ctx: Context, request: { mcpConfigJson: string; removeMissing: true }): Promise<{ loadedServerNames: string[] }> }
export function isUnimplementedConnectError(error: unknown): boolean { if (typeof error !== "object" || error == null) return false; const code = (error as { code?: unknown }).code; return code === 12 || code === "unimplemented" || code === "UNIMPLEMENTED"; }
export async function loadBoxMcpServersViaTransport<Transport>(ctx: Context, transport: Transport, configJson: string, createClient: (transport: Transport) => BoxMcpControlClient): Promise<string[]> { const control = createClient(transport); try { return (await control.loadMcpServers(ctx, { mcpConfigJson: configJson, removeMissing: true })).loadedServerNames; } catch (error) { if (isUnimplementedConnectError(error)) throw new SlateBoxMcpUnsupportedError(BOX_MCP_UNSUPPORTED_MESSAGE, { cause: error }); throw error; } }
