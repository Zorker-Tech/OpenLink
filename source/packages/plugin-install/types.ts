/**
 * The shapes a plugin's MCP configuration takes.
 *
 * A plugin describes the MCP servers it brings as configuration: a command with arguments, an environment and a working
 * directory, or a URL with headers, and either way the tools it enables and the credentials it authenticates with. The
 * schema is what a manifest is read against, so a configuration that does not match is refused rather than half-read.
 * The metrics logger a loader is handed is silent by default, so a caller that does not care is not forced to.
 */
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

/** A plugin connection after its external file has crossed the marketplace adapter. */
export interface McpServerConfig {
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  cwd?: string | undefined;
  envFile?: string | undefined;
  auth?: { CLIENT_ID: string; CLIENT_SECRET?: string | undefined; scopes?: string[] | undefined } | undefined;
  enabledTools?: string[] | undefined;
}

/** The installed plugin's set of server connections. */
export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig> | undefined;
}
