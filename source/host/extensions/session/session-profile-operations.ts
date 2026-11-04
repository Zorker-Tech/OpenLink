import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SlateAgentProfile } from "../../agents/agent-profile.ts"
import type { SlateAgentDb } from "./agent-db.ts"
import { setAgentAvatarBytes } from "./session-mutations.ts"
import {
  getAgentAvatar,
  getAgentAvatarPng,
  getAgentProfileText,
  updateAgentProfile,
} from "./session-profile-files.ts"
import { ACTIVE_AGENT_FILENAME, getAgentDbPath } from "./session-paths.ts"
import type { SessionMemoryProvider } from "./agent-session.ts"

interface ProfileOperationsDependencies {
  readonly rootDir: string
  readonly agentDir: (agentId: string) => string
  readonly withAgentDb: <T>(
    agentId: string,
    operation: (db: SlateAgentDb, dbPath: string) => T | Promise<T>,
  ) => Promise<T>
  readonly writeProfileFile: (
    agentId: string,
    profile: Partial<SlateAgentProfile> & { name: string; description: string },
  ) => void
  readonly statOpenDb: (
    args: { dbPath: string; agentId: string },
  ) => Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>
  readonly memory: () => SessionMemoryProvider
}

export class SessionProfileOperations {
  constructor(private readonly dependencies: ProfileOperationsDependencies) {}

  activePointerPath(): string {
    return join(this.dependencies.rootDir, ACTIVE_AGENT_FILENAME)
  }

  readActiveAgentId(): string | null {
    try {
      const value = JSON.parse(readFileSync(this.activePointerPath(), "utf8")) as {
        activeAgentId?: unknown
      }
      return typeof value.activeAgentId === "string" && value.activeAgentId.length > 0
        ? value.activeAgentId
        : null
    } catch {
      return null
    }
  }

  writeActiveAgentId(agentId: string): void {
    try {
      mkdirSync(this.dependencies.rootDir, { recursive: true })
      const path = this.activePointerPath()
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, JSON.stringify({ activeAgentId: agentId }))
      renameSync(temporaryPath, path)
    } catch {
      // The active pointer is a convenience and must never block session use.
    }
  }

  async update(
    agentId: string,
    profile: Partial<SlateAgentProfile> & { name: string; description: string },
  ) {
    return updateAgentProfile(this.#host(), agentId, profile)
  }

  profileText(agentId: string) {
    return getAgentProfileText(this.#host(), agentId)
  }

  avatar(agentId: string) {
    return getAgentAvatar(this.#host(), agentId)
  }

  avatarPng(agentId: string) {
    return getAgentAvatarPng(this.#host(), agentId)
  }

  async setAvatar(
    db: SlateAgentDb,
    dbPath: string,
    agentId: string,
    pngBytes: Uint8Array | null,
    activeAgentId?: string,
  ) {
    return setAgentAvatarBytes(
      { memory: this.dependencies.memory() },
      db,
      dbPath,
      agentId,
      pngBytes,
      activeAgentId,
    )
  }

  async setAvatarById(agentId: string, pngBytes: Uint8Array | null) {
    return this.dependencies.withAgentDb(
      agentId,
      (db, dbPath) => this.setAvatar(db, dbPath, agentId, pngBytes),
    )
  }

  #host() {
    return {
      memory: this.dependencies.memory(),
      agentExists: (agentId: string) =>
        existsSync(getAgentDbPath(this.dependencies.rootDir, agentId)),
      getAgentDir: this.dependencies.agentDir,
      withAgentDb: this.dependencies.withAgentDb,
      statOpenDb: this.dependencies.statOpenDb,
      writeAgentProfileFile: this.dependencies.writeProfileFile,
    }
  }
}
