import type { LogShipBufferedEntry } from "./log-ship-contracts.ts"
import { LOG_SHIP_MAX_BATCH_BYTES, LOG_SHIP_MAX_BATCH_ENTRIES } from "./log-ship-policy.ts"

export function takeLogShipBatch<Entry extends LogShipBufferedEntry>(
  buffer: readonly Entry[],
): { batch: Entry[]; remaining: Entry[] } {
  let usedBudget = 0
  let selectedCount = 0

  for (let index = 0; index < buffer.length && selectedCount < LOG_SHIP_MAX_BATCH_ENTRIES; index += 1) {
    const entry = buffer[index]!
    let entryBudget = entry.message.length
    for (const [key, value] of Object.entries(entry.metadata)) entryBudget += key.length + value.length
    if (selectedCount > 0 && usedBudget + entryBudget > LOG_SHIP_MAX_BATCH_BYTES) break
    usedBudget += entryBudget
    selectedCount += 1
  }

  return {
    batch: buffer.slice(0, selectedCount),
    remaining: buffer.slice(selectedCount),
  }
}
