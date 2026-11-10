import { SlateMcpConfigError } from "./mcp-config-error.ts";

const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const MAX_SERVER_INTEGER = 2_147_483_647;

function hasPositiveDecimalShape(value: string): boolean {
  return POSITIVE_DECIMAL.test(value);
}

export function isMcpServerId(rawId: string): boolean {
  return hasPositiveDecimalShape(rawId.trim());
}

export function validateMcpServerId(rawId: string): string {
  const cleaned = rawId.trim();
  if (!hasPositiveDecimalShape(cleaned)) {
    throw new SlateMcpConfigError("MCP server ID must be a positive decimal string.");
  }
  return cleaned;
}

function asSupportedInteger(cleaned: string): number {
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value) || value > MAX_SERVER_INTEGER) {
    throw new SlateMcpConfigError("MCP server ID is outside the supported range.");
  }
  return value;
}

export function parseInt32McpServerId(rawId: string): number {
  return asSupportedInteger(validateMcpServerId(rawId));
}
