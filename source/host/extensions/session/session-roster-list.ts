import { readdir } from "node:fs/promises";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { getAgentDbPath, statIfExists } from "./session-paths.ts";
import { buildSummary, minimalAgentSummary } from "./session-summaries.ts";
import { reportSessionDiagnostic } from "./session-diagnostics.ts";
import type { SessionRosterHost } from "./session-roster-contracts.ts";

type AgentSummary = Record<string, unknown>;

function activeAgentOptions(activeAgentId?: string): { readonly activeAgentId?: string } {
  return activeAgentId == null ? {} : { activeAgentId };
}

async function recoverMissingAgent(host: SessionRosterHost, dirName: string, activeAgentId?: string): Promise<AgentSummary | null> {
  const dbPath = getAgentDbPath(host.rootDir, dirName);
  try {
    return await host.recoverAgentWithMissingDb({ dbPath, dirName, ...activeAgentOptions(activeAgentId) });
  } catch (error) {
    reportSessionDiagnostic({ family: "summary_build", kind: "recovery_build_failed", agentId: dirName, errorClass: errorLogTag(error) });
    return minimalAgentSummary({ dirName, dbPath, ...activeAgentOptions(activeAgentId) });
  }
}

async function readAgentSummary(host: SessionRosterHost, dirName: string, activeAgentId?: string): Promise<AgentSummary | null> {
  const dbPath = getAgentDbPath(host.rootDir, dirName);
  const stats = await statIfExists(dbPath);
  if (stats == null) return recoverMissingAgent(host, dirName, activeAgentId);
  const dbStats = { size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) };

  try {
    const extras = await host.loadCachedExtras({ dirName, dbPath, dbStats });
    if (host.isAgentBeingDeleted(dirName)) return null;
    return await buildSummary({
      extras,
      dbPath,
      dirName,
      dbStats,
      ...activeAgentOptions(activeAgentId),
      includeBlank: false,
      agentHasMemory: (directory) => host.memory.agentHasContent(directory),
    });
  } catch (error) {
    if (host.isAgentBeingDeleted(dirName)) return null;
    reportSessionDiagnostic({ family: "summary_build", kind: "degraded", agentId: dirName, errorClass: errorLogTag(error) });
    try {
      return await buildSummary({
        extras: null,
        dbPath,
        dirName,
        dbStats,
        ...activeAgentOptions(activeAgentId),
        includeBlank: true,
        agentHasMemory: (directory) => host.memory.agentHasContent(directory),
      });
    } catch (fallbackError) {
      reportSessionDiagnostic({ family: "summary_build", kind: "degraded_failed", agentId: dirName, errorClass: errorLogTag(fallbackError) });
      return minimalAgentSummary({ dirName, dbPath, dbStats, ...activeAgentOptions(activeAgentId) });
    }
  }
}

export async function listAgents(host: SessionRosterHost, activeAgentId?: string): Promise<AgentSummary[]> {
  let entries;
  try {
    entries = await readdir(host.rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  const summaries = await Promise.all(directories.map(async (entry) => {
    if (host.isAgentBeingDeleted(entry.name)) return null;
    return readAgentSummary(host, entry.name, activeAgentId);
  }));
  host.pruneExtrasCache(new Set(entries.map((entry) => entry.name)));
  return summaries
    .filter((summary): summary is AgentSummary => summary != null)
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
}
