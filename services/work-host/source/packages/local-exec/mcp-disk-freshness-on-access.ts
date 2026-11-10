/**
 * Keeping the MCP catalog on disk fresh when something reads it.
 *
 * The catalog is a cache of what the MCP servers reported, and a reader that finds it stale should not have to wait for
 * the next lease event: a read of a path inside the catalog schedules a refresh, debounced so that a burst of reads is
 * one refresh rather than one per read, and the mcpState that was read is what decides whether the refresh is worth
 * doing at all.
 */
import { createCounter, createHistogram } from "../metrics/index.ts";
import type { Context } from "../context/context.ts";
import { createLogger } from "../context/logging.ts";
import { readMcpDiskCatalogToolNamesForProjectDir } from "./mcp-disk-catalog-read.ts";
import { sanitizeServerName } from "./mcp.ts";

const logger = createLogger("local-exec:mcp-disk-freshness-on-access");
const MCPS_SEGMENT = "/mcps/";
const DEBOUNCE_MS = 2_000;

const mcpDiscoveryFreshnessCheck = createCounter("mcp.discovery_freshness.check", {
  description: "MCP discovery surface freshness comparison outcome against canonical live tools",
  labelNames: ["surface", "outcome"],
});
const mcpDiscoveryFreshnessMissingTools = createHistogram("mcp.discovery_freshness.missing_tools", {
  description: "Number of tools present in canonical live state but missing from the observed discovery surface",
  labelNames: ["surface"],
});
const mcpDiscoveryFreshnessExtraTools = createHistogram("mcp.discovery_freshness.extra_tools", {
  description: "Number of tools present on the observed discovery surface but absent from canonical live state",
  labelNames: ["surface"],
});
const mcpDiscoveryFreshnessSymmetricDifference = createHistogram("mcp.discovery_freshness.symmetric_difference", {
  description: "Total symmetric difference between canonical live tools and the observed discovery surface",
  labelNames: ["surface"],
});

export interface DiskMcpTool { readonly toolName: string }
export interface DiskMcpServer { readonly serverIdentifier: string; readonly tools: readonly DiskMcpTool[] }
export interface DiskMcpState { readonly servers: readonly DiskMcpServer[] }
export interface McpStateAccessor { getState(ctx: Context): Promise<DiskMcpState> }
type DiskCatalogReader = typeof readMcpDiskCatalogToolNamesForProjectDir;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function normalizedMcpsPath(filePath: string): string {
  const flatPath = filePath.replace(/\\/g, "/");
  return flatPath.endsWith("/mcps") ? `${flatPath}/` : flatPath;
}

export function isMcpDirectoryPath(filePath: string | undefined): boolean {
  return filePath !== undefined && normalizedMcpsPath(filePath).includes(MCPS_SEGMENT);
}

type ParsedMcpsPath =
  | { readonly projectDir: string; readonly kind: "mcps_root" }
  | { readonly projectDir: string; readonly kind: "server"; readonly sanitizedServerFolder: string };

export function parseMcpsPath(filePath: string): ParsedMcpsPath | undefined {
  const flatPath = normalizedMcpsPath(filePath);
  const segmentIndex = flatPath.indexOf(MCPS_SEGMENT);
  if (segmentIndex === -1) return undefined;
  const projectDir = flatPath.slice(0, segmentIndex);
  const remainder = flatPath.slice(segmentIndex + MCPS_SEGMENT.length);
  const segments = remainder.split("/").filter(Boolean);
  if (projectDir.length === 0) return undefined;
  if (segments.length === 0) return { projectDir, kind: "mcps_root" };
  return { projectDir, kind: "server", sanitizedServerFolder: segments[0]! };
}

function reportDiskFreshness(input: {
  readonly ctx: Context;
  readonly serverIdentifier: string;
  readonly canonicalToolNames: readonly string[];
  readonly observedToolNames: readonly string[];
}): void {
  const observedSet = new Set(input.observedToolNames);
  const canonicalSet = new Set(input.canonicalToolNames);
  const missingNames = input.canonicalToolNames.filter((name) => !observedSet.has(name));
  const extraNames = input.observedToolNames.filter((name) => !canonicalSet.has(name));
  const comparison = missingNames.length === 0 && extraNames.length === 0 ? "match" : "mismatch";
  const labels = { surface: "disk" };
  mcpDiscoveryFreshnessCheck.increment(input.ctx, 1, { ...labels, outcome: comparison });
  mcpDiscoveryFreshnessMissingTools.histogram(input.ctx, missingNames.length, labels);
  mcpDiscoveryFreshnessExtraTools.histogram(input.ctx, extraNames.length, labels);
  mcpDiscoveryFreshnessSymmetricDifference.histogram(input.ctx, missingNames.length + extraNames.length, labels);
  if (comparison === "mismatch") {
    logger.warn(input.ctx, "mcp_disk_discovery_freshness_mismatch", {
      server_identifier: input.serverIdentifier,
      missing_tool_count: missingNames.length,
      extra_tool_count: extraNames.length,
    });
  }
}

async function checkDiskFreshness(input: {
  readonly ctx: Context;
  readonly mcpStateAccessor: McpStateAccessor;
  readonly projectDir: string;
  readonly sanitizedServerFolder: string;
  readonly readDiskCatalog: DiskCatalogReader;
  readonly mcpState?: DiskMcpState;
}): Promise<void> {
    let mcpState = input.mcpState;
  if (mcpState === undefined) {
    try { mcpState = await input.mcpStateAccessor.getState(input.ctx); }
    catch (failure) {
      logger.warn(input.ctx, "mcp_disk_state_read_failed", { error_type: failure instanceof Error ? failure.name : typeof failure });
      return;
    }
  }
  const serverEntry = mcpState.servers.find((serverState) => sanitizeServerName(serverState.serverIdentifier) === input.sanitizedServerFolder);
  if (serverEntry === undefined) return;
  let catalog: Awaited<ReturnType<DiskCatalogReader>>;
  try { catalog = await input.readDiskCatalog(input.projectDir, serverEntry.serverIdentifier); }
  catch (failure) {
    logger.warn(input.ctx, "mcp_disk_catalog_read_failed", { error_type: failure instanceof Error ? failure.name : typeof failure });
    return;
  }
  if (!catalog.toolsDirExists) return;
  const canonicalToolNames = serverEntry.tools.map((tool) => tool.toolName).filter((name) => name.length > 0).sort((a, b) => a.localeCompare(b));
  reportDiskFreshness({ ctx: input.ctx, serverIdentifier: serverEntry.serverIdentifier, canonicalToolNames, observedToolNames: catalog.toolNames });
}

export function scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(
  ctx: Context,
  mcpStateAccessor: McpStateAccessor,
  filePath: string | undefined,
  readDiskCatalog: DiskCatalogReader = readMcpDiskCatalogToolNamesForProjectDir,
): void {
  if (!isMcpDirectoryPath(filePath) || filePath === undefined) return;
  const parsed = parseMcpsPath(filePath);
  if (parsed === undefined) return;
  const rootAccess = parsed.kind === "mcps_root";
  const key = rootAccess ? `${parsed.projectDir}\0__mcps_root__` : `${parsed.projectDir}\0${parsed.sanitizedServerFolder}`;
  const folderToCheck = rootAccess ? undefined : parsed.sanitizedServerFolder;
  const previousTimer = pendingTimers.get(key);
  if (previousTimer !== undefined) clearTimeout(previousTimer);
  const scheduledCtx = ctx;
  const scheduled = setTimeout(() => {
    pendingTimers.delete(key);
    const sweepServers = async (): Promise<void> => {
      if (rootAccess) {
        const mcpState = await mcpStateAccessor.getState(scheduledCtx);
        for (const serverEntry of mcpState.servers) {
          await checkDiskFreshness({
            ctx: scheduledCtx,
            mcpStateAccessor,
            projectDir: parsed.projectDir,
            sanitizedServerFolder: sanitizeServerName(serverEntry.serverIdentifier),
            readDiskCatalog,
            mcpState,
          });
        }
        return;
      }
      if (folderToCheck !== undefined) {
        await checkDiskFreshness({ ctx: scheduledCtx, mcpStateAccessor, projectDir: parsed.projectDir, sanitizedServerFolder: folderToCheck, readDiskCatalog });
      }
    };
    void sweepServers().catch((failure) => {
      logger.warn(scheduledCtx, "mcp_disk_discovery_freshness_schedule_failed", { error_type: failure instanceof Error ? failure.name : typeof failure });
    });
  }, DEBOUNCE_MS);
  pendingTimers.set(key, scheduled);
}
