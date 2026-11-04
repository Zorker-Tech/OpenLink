import {
  applyExtractedMemories,
  extractMemories,
  gatherExtractionMemories,
  MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT,
  MEMORY_RECENT_PROMPT_LIMIT,
} from "./slate-memory.ts"
import type { TurnMemorySession, FinishedTurnExchange, SlateTurnMemoryStore } from "./turn-memory-contracts.ts"

/** Extracts durable facts opportunistically; a failed extraction never holds up turn settlement. */
export async function extractCompletedTurnMemories(
  memoryStore: SlateTurnMemoryStore,
  session: TurnMemorySession,
  context: unknown,
  exchange: FinishedTurnExchange,
): Promise<void> {
  try {
    const existingMemories = gatherExtractionMemories(
      memoryStore.recall(MEMORY_RECENT_PROMPT_LIMIT),
      memoryStore.listMemories(MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT),
      `${exchange.user}\n${exchange.agent}`,
    )
    const extraction = await extractMemories({
      executor: session.getExecutor(),
      ctx: context,
      userMessage: exchange.user,
      agentMessage: exchange.agent,
      existingMemories,
    })
    applyExtractedMemories(memoryStore, extraction, Date.now(), existingMemories)
  } catch {
    // Extraction is opportunistic and does not participate in turn settlement.
  }
}
