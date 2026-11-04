import { getAgentDbPath, statIfExists } from "./session-paths.ts";
import { buildSummary } from "./session-summaries.ts";
import type { SessionRosterHost } from "./session-roster-contracts.ts";

export async function summarizeAgentById(
  host: SessionRosterHost,
  agentId: string,
  activeAgentId?: string,
): Promise<Record<string, unknown> | null> {
  if (host.isAgentBeingDeleted(agentId)) return null;
  const dbPath = getAgentDbPath(host.rootDir, agentId);
  const stats = await statIfExists(dbPath);
  if (stats == null) {
    return await host.recoverAgentWithMissingDb({
      dbPath,
      dirName: agentId,
      ...(activeAgentId == null ? {} : { activeAgentId }),
    });
  }
  const dbStats = { size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) };
  const extras = await host.loadCachedExtras({ dirName: agentId, dbPath, dbStats });
  if (host.isAgentBeingDeleted(agentId)) return null;
  return await buildSummary({
    extras,
    dbPath,
    dirName: agentId,
    dbStats,
    ...(activeAgentId == null ? {} : { activeAgentId }),
    includeBlank: true,
    agentHasMemory: (directory) => host.memory.agentHasContent(directory),
  });
}
