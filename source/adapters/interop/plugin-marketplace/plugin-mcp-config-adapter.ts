/** Parses the external plugin MCP configuration format into the host's plugin connection values. */
import { z } from "zod";
import type { McpConfig, McpServerConfig } from "../../../packages/plugin-install/types.ts";

const stringRecordSchema = z.record(z.string(), z.string());

const authenticationSchema = z.object({
  CLIENT_ID: z.string(),
  CLIENT_SECRET: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

export const externalPluginMcpServerConfigSchema: z.ZodType<McpServerConfig> = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  url: z.string().optional(),
  headers: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  envFile: z.string().optional(),
  auth: authenticationSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
});

export const externalPluginMcpConfigSchema: z.ZodType<McpConfig> = z.object({
  mcpServers: z.record(z.string(), externalPluginMcpServerConfigSchema).optional(),
});

/** Invalid external fields reject the full document rather than returning a partial server map. */
export function parseExternalPluginMcpConfig(value: unknown) {
  return externalPluginMcpConfigSchema.safeParse(value);
}
