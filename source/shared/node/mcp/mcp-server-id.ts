/**
 * The id an MCP server is known by.
 *
 * A server's id is a positive decimal number spelled as a string, and it has to fit in the range the rest of the
 * platform holds ids in: an id that is not one, or one that is outside the range, is refused with the reason rather
 * than truncated or wrapped.
 */
import { SlateMcpConfigError } from "./mcp-config-error.ts";
const MCP_SERVER_ID_PATTERN = /^[1-9]\d*$/;
export function isMcpServerId(rawId: string): boolean { return MCP_SERVER_ID_PATTERN.test(rawId.trim()); }
export function validateMcpServerId(rawId: string): string { const id = rawId.trim(); if (!isMcpServerId(id)) throw new SlateMcpConfigError("MCP server ID must be a positive decimal string."); return id; }
export function parseInt32McpServerId(rawId: string): number { const parsed = Number(validateMcpServerId(rawId)); if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) throw new SlateMcpConfigError("MCP server ID is outside the supported range."); return parsed; }
