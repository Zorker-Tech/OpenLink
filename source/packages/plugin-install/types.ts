/**
 * The shapes a plugin's MCP configuration takes.
 *
 * A plugin describes the MCP servers it brings as configuration: a command with arguments, an environment and a working
 * directory, or a URL with headers, and either way the tools it enables and the credentials it authenticates with. The
 * schema is what a manifest is read against, so a configuration that does not match is refused rather than half-read.
 * The metrics logger a loader is handed is silent by default, so a caller that does not care is not forced to.
 */
import { z } from "zod";

export interface PluginMetricsLogger {
  log(level: "debug" | "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>): void;
  increment(name: string, value: number, tags?: Record<string, string>): void;
  distribution(name: string, value: number, tags?: Record<string, string>): void;
  captureException(error: unknown, tags?: Record<string, string>): void;
}

/** The four things a logger is asked to do, named once so the silent one can be built from them. */
const METRICS_METHODS = ["log", "increment", "distribution", "captureException"] as const;

/** A logger that reports nothing: every method, doing nothing and answering nothing. */
export const noopPluginMetricsLogger: PluginMetricsLogger = Object.freeze(
  Object.fromEntries(METRICS_METHODS.map((method) => [method, () => {}])),
) as unknown as PluginMetricsLogger;

/** A name-to-text map, which is what both an environment and a set of headers is. */
const STRING_RECORD = z.record(z.string(), z.string());

/** The credentials a server authenticates with, when it needs any of its own. */
const AUTH = z.object({
  CLIENT_ID: z.string(),
  CLIENT_SECRET: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

export const mcpServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: STRING_RECORD.optional(),
  url: z.string().optional(),
  headers: STRING_RECORD.optional(),
  cwd: z.string().optional(),
  envFile: z.string().optional(),
  auth: AUTH.optional(),
  enabledTools: z.array(z.string()).optional(),
});

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
