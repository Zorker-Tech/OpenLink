import { SlateAgentDb } from "./agent-db.ts"
import { getAgentDbPath } from "./session-paths.ts"

/** Run a synchronous read with a temporary DB handle and use the caller's empty projection on failure. */
export function readWithAgentDatabase<Value>(
  rootDir: string,
  agentId: string,
  read: (database: SlateAgentDb) => Value,
  fallback: Value,
): Value {
  let database: SlateAgentDb | undefined
  try {
    database = new SlateAgentDb(getAgentDbPath(rootDir, agentId), { recoverOnCorruption: false })
    return read(database)
  } catch {
    return fallback
  } finally {
    database?.close()
  }
}
