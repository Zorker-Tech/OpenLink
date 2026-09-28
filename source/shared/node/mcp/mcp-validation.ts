/**
 * What a server may be called.
 *
 * A name that would collide with the object it is stored in is refused, and so is one that says nothing, so a
 * configuration cannot be used to reach past what it is meant to describe.
 */
import { SlateMcpConfigError } from "./mcp-config-error.ts"; import type { McpServerConfig } from "./mcp-display-runtime.ts";
const RESERVED_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);
export function getTransport(config: McpServerConfig): "stdio" | "sse" | "http" { return "command" in config ? "stdio" : config.type === "sse" ? "sse" : "http"; }
export function getCommand(config: McpServerConfig): string | undefined { return "command" in config ? [config.command, ...(config.args ?? [])].join(" ") : undefined; }
export function validateServerName(raw: string): string { const name = raw.trim(); if (name.length === 0) throw new SlateMcpConfigError("MCP server name is required."); if (RESERVED_SERVER_NAMES.has(name)) throw new SlateMcpConfigError(`MCP server name "${name}" is reserved.`); if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new SlateMcpConfigError("MCP server names cannot include slashes or null bytes."); if (name.includes("--")) throw new SlateMcpConfigError('MCP server names cannot include "--".'); return name; }
export function parseServerConfig(configJson: string, parse: (value: unknown) => McpServerConfig): McpServerConfig { return parse(JSON.parse(configJson) as unknown); }
export function toJsonArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    typeof value === "object" && value != null && "toJson" in value && typeof value.toJson === "function"
      ? value.toJson()
      : value,
  ]));
}
