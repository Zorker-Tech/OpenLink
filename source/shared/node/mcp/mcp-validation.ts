/** Policies for MCP server labels and the Slate-owned configuration values they name. */

import { SlateMcpConfigError } from "./mcp-config-error.ts"
import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts"

const SERVER_LABEL_COLLISIONS = new Set(["__proto__", "constructor", "prototype"])

export function getTransport(config: SlateMcpServerConfig): "stdio" | "sse" | "http" {
  if ("command" in config) return "stdio"
  return config.type === "sse" ? "sse" : "http"
}

export function getCommand(config: SlateMcpServerConfig): string | undefined {
  if (!("command" in config)) return undefined
  return [config.command, ...(config.args ?? [])].join(" ")
}

function containsPathControl(name: string): boolean {
  return name.includes("/") || name.includes("\\") || name.includes("\0")
}

export function validateServerName(raw: string): string {
  const name = raw.trim()
  if (name.length === 0) throw new SlateMcpConfigError("MCP server name is required.")
  if (SERVER_LABEL_COLLISIONS.has(name)) throw new SlateMcpConfigError(`MCP server name "${name}" is reserved.`)
  if (containsPathControl(name)) throw new SlateMcpConfigError("MCP server names cannot include slashes or null bytes.")
  if (name.includes("--")) throw new SlateMcpConfigError('MCP server names cannot include "--".')
  return name
}

export function parseServerConfig(
  configJson: string,
  parse: (value: unknown) => SlateMcpServerConfig,
): SlateMcpServerConfig {
  const sourceValue: unknown = JSON.parse(configJson)
  return parse(sourceValue)
}
