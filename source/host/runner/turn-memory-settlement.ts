import { getEpisodeInterval, MEMORY_EPISODE_PREFIX, summarizeEpisode } from "./slate-memory.ts"
import type { MemoryEpisodeProgress, TurnMemorySession, FinishedTurnExchange, SlateTurnMemoryStore } from "./turn-memory-contracts.ts"
import { extractCompletedTurnMemories } from "./turn-memory-extraction.ts"

/** Completes the memory work associated with one finished user/agent exchange. */
export async function settleCompletedTurnMemory(
  memoryStore: SlateTurnMemoryStore,
  episodeProgress: MemoryEpisodeProgress | null | undefined,
  session: TurnMemorySession,
  context: unknown,
  turnTimestamp: number,
  exchange: FinishedTurnExchange,
): Promise<void> {
  if (memoryStore.recordMemoryEvidence != null) {
    episodeProgress?.clearPendingEpisodeTurns()
    memoryStore.recordMemoryEvidence({ occurredAt: turnTimestamp, user: exchange.user, assistant: exchange.agent })
    return
  }

  await extractCompletedTurnMemories(memoryStore, session, context, exchange)
  if (episodeProgress == null) return

  try {
    episodeProgress.recordEpisodeTurn({ ts: turnTimestamp, user: exchange.user, agent: exchange.agent })
    const pendingTurns = episodeProgress.getPendingEpisodeTurns()
    if (pendingTurns.length < getEpisodeInterval()) return

    try {
      const summary = await summarizeEpisode({
        executor: session.getExecutor(),
        ctx: context,
        turns: pendingTurns,
      })
      if (summary != null) {
        const latestTimestamp = pendingTurns[pendingTurns.length - 1]?.ts ?? turnTimestamp
        memoryStore.addMemory(`${MEMORY_EPISODE_PREFIX}${summary}`, latestTimestamp, "log")
      }
    } finally {
      episodeProgress.clearPendingEpisodeTurns()
    }
  } catch {
    // Memory maintenance must never fail the user-visible turn.
  }
}
