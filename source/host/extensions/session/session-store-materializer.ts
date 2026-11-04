import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { getSlateProfilePath, writeSlateProfileFile, type SlateAgentProfile } from "../../agents/agent-profile.ts";
import { getSlateSettingsPath, writeAgentSettings } from "../../agents/settings-file.ts";
import { SlateAgentDb } from "./agent-db.ts";
import { getAgentDbPath } from "./session-paths.ts";
import { automationStoreForDbPath, channelStoreForDbPath, workflowStoreForDbPath } from "./session-store-factories.ts";
import { DEFAULT_AGENT_AUTOMATIONS, SlateAgentMissingError, type MaterializationHost, type MaterializedSession } from "./session-materialization-contracts.ts";
import type { AgentWorkerPool } from "../../agents/isolation/agent-worker-pool.ts";

export class SessionStoreMaterializer {
  constructor(
    private readonly hostServices: MaterializationHost,
    private readonly workerPool: () => AgentWorkerPool,
  ) {}

  async createAgent(agentId: string, profile?: Partial<SlateAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<MaterializedSession> {
    const dbPath = getAgentDbPath(this.hostServices.rootDir, agentId);
    const db = new SlateAgentDb(dbPath);
    try {
      db.set("agentId", agentId);
      db.setAgentOrigin(origin);
      if (purpose != null) db.setAgentPurpose(purpose);
      this.writeInitialAgentFiles(dirname(dbPath), profile);
      const session = this.assembleSession(agentId, dbPath, db);
      for (const automation of DEFAULT_AGENT_AUTOMATIONS) session.automations.upsert(automation as never);
      return session;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async openAgent(agentId: string): Promise<MaterializedSession> {
    if (!this.hostServices.agentExists(agentId)) throw new SlateAgentMissingError(agentId);
    const dbPath = getAgentDbPath(this.hostServices.rootDir, agentId);
    const db = new SlateAgentDb(dbPath);
    try {
      await this.restoreMissingProfile(dirname(dbPath), db);
      const session = this.assembleSession(agentId, dbPath, db);
      await session.agentStore.resetFromDb?.(this.hostServices.ctx);
      await this.hostServices.runMaintenance?.(session);
      return session;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private assembleSession(agentId: string, dbPath: string, db: SlateAgentDb): MaterializedSession {
    const agentDir = dirname(dbPath);
    return {
      id: agentId,
      dbPath,
      db,
      agentStore: this.hostServices.createAgentStore({ pool: this.workerPool(), agentId, dbPath, db }),
      memory: this.hostServices.createMemoryStore(agentDir),
      automations: automationStoreForDbPath(dbPath, this.hostServices.resolveUserTimeZone),
      workflows: workflowStoreForDbPath(dbPath, this.hostServices.resolveUserTimeZone),
      channels: channelStoreForDbPath(dbPath),
    };
  }

  private writeInitialAgentFiles(agentDir: string, profile: Partial<SlateAgentProfile> | undefined): void {
    writeSlateProfileFile(getSlateProfilePath(agentDir), {
      name: profile?.name?.trim() || "New Bot",
      description: profile?.description?.trim() ?? "",
      title: profile?.title?.trim() ?? "",
      avatarShape: profile?.avatarShape?.trim() ?? "",
      avatarColor: profile?.avatarColor?.trim() ?? "",
    });
    writeAgentSettings(getSlateSettingsPath(agentDir), { notifyOnAgentUpdates: true });
  }

  private async restoreMissingProfile(agentDir: string, db: SlateAgentDb): Promise<void> {
    const profilePath = getSlateProfilePath(agentDir);
    try {
      await stat(profilePath);
    } catch {
      writeSlateProfileFile(profilePath, {
        name: db.get("name") || "New Bot",
        description: db.getSlateProfile().description,
        title: "",
        avatarShape: "",
        avatarColor: "",
      });
    }
  }
}
