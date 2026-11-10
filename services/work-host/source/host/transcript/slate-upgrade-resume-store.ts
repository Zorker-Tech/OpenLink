import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { SLATE_UPGRADE_RESUME_FILE_NAME } from "../durable-file-policy.ts"
import {
  coerceMarker2,
  coerceUpgradeResumeMarker,
  parseUpgradeResumeFile,
  upsertResumeMarker,
} from "./upgrade-resume-store-codec.ts"
import type { UpgradeResumeMarker } from "./upgrade-resume-store-contracts.ts"

export {
  coerceMarker2,
  coerceUpgradeResumeMarker,
  parseUpgradeResumeFile,
  upsertResumeMarker,
}
export type { UpgradeResumeMarker } from "./upgrade-resume-store-contracts.ts"

export class SlateUpgradeResumeStore {
  readonly filePath: string

  constructor(rootDir: string) {
    this.filePath = join(rootDir, SLATE_UPGRADE_RESUME_FILE_NAME)
  }

  markPending(marker: UpgradeResumeMarker): void {
    try {
      this.write(upsertResumeMarker(this.readPending(), marker))
    } catch {
    }
  }

  listPending(): UpgradeResumeMarker[] {
    return this.readPending()
  }

  clear(agentId: string): void {
    try {
      const remaining = this.readPending().filter((marker) => marker.agentId !== agentId)
      if (remaining.length === 0) this.deleteFile()
      else this.write(remaining)
    } catch {
    }
  }

  clearAll(): void {
    this.deleteFile()
  }

  readPending(): UpgradeResumeMarker[] {
    try {
      return parseUpgradeResumeFile(readFileSync(this.filePath, "utf8"))
    } catch {
      return []
    }
  }

  write(pending: readonly UpgradeResumeMarker[]): void {
    const partPath = `${this.filePath}.part`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
    } catch {
    }
    writeFileSync(partPath, JSON.stringify({ version: 1, pending }))
    renameSync(partPath, this.filePath)
  }

  deleteFile(): void {
    try {
      rmSync(this.filePath, { force: true })
    } catch {
    }
  }
}
