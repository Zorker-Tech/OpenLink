import type { SlateAgentProfile } from "../../agents/agent-profile.ts";
import { buildSummary, loadAgentDbExtras } from "./session-summaries.ts";
import type { SessionProfileUpdateHost } from "./session-profile-contracts.ts";

export async function updateAgentProfile(
  host: SessionProfileUpdateHost,
  agentId: string,
  profile: Partial<SlateAgentProfile> & { name: string; description: string },
) {
  return await host.withAgentDb(agentId, async (db, dbPath) => {
    host.writeAgentProfileFile(agentId, profile);
    const dbStats = await host.statOpenDb({ dbPath, agentId });
    return await buildSummary({
      extras: loadAgentDbExtras(db, dbPath, agentId, dbStats),
      dbPath,
      dirName: agentId,
      ...(dbStats == null ? {} : { dbStats }),
      includeBlank: true,
      agentHasMemory: (directory) => host.memory.agentHasContent(directory),
    });
  });
}
