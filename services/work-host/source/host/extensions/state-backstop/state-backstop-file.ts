import { existsSync, readFileSync } from "node:fs"

/** Take a checkpoint before reading the SQLite file so the snapshot sees a consistent database image. */
export function readStoreDbBytes(dbPath: string, checkpoint: (path: string) => void): Buffer | null {
  if (!existsSync(dbPath)) return null
  checkpoint(dbPath)
  return readFileSync(dbPath)
}
