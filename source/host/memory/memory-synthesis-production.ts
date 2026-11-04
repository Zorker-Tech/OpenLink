/** Creates the scheduled synthesis worker from the host's inference and reporting ports. */

import {
  createDeadlinePolicy,
  createRealDebouncePolicy,
  createRealPollingPolicy,
  createRealRetryPolicy,
  realClock,
} from "../extensions/scheduling.ts"
import { SLATE_SUMMARIZATION_MODEL_ID } from "../../shared/agents/slate-agent-model.ts"
import type { MemoryService } from "./memory-service.ts"
import {
  MEMORY_SYNTHESIS_DEADLINE_MS,
  MEMORY_SYNTHESIS_DEBOUNCE_MS,
  MEMORY_SYNTHESIS_POLL_INTERVAL_MS,
  MEMORY_SYNTHESIS_RETRY_ATTEMPTS,
  MEMORY_SYNTHESIS_RETRY_INITIAL_MS,
  MEMORY_SYNTHESIS_RETRY_MAX_MS,
  MemorySynthesisService,
  memorySynthesisTelemetryReport,
} from "./memory-synthesis-service.ts"
import type { MemoryProductionContext } from "./memory-production-contracts.ts"

export function createMemorySynthesisProductionService(
  context: MemoryProductionContext,
  memory: MemoryService,
): MemorySynthesisService {
  return new MemorySynthesisService({
    debounce: createRealDebouncePolicy({
      name: "slate-memory-synthesis",
      delayMs: MEMORY_SYNTHESIS_DEBOUNCE_MS,
    }),
    deadline: createDeadlinePolicy(realClock, {
      name: "slate-memory-synthesis-inference",
      timeoutMs: MEMORY_SYNTHESIS_DEADLINE_MS,
    }),
    polling: createRealPollingPolicy({
      name: "slate-memory-temporal-refresh",
      intervalMs: MEMORY_SYNTHESIS_POLL_INTERVAL_MS,
    }),
    retry: createRealRetryPolicy({
      name: "slate-memory-synthesis-retry",
      maxAttempts: MEMORY_SYNTHESIS_RETRY_ATTEMPTS,
      initialDelayMs: MEMORY_SYNTHESIS_RETRY_INITIAL_MS,
      maxDelayMs: MEMORY_SYNTHESIS_RETRY_MAX_MS,
    }),
    getTarget: agentId => memory.synthesisTargetForAgent(agentId),
    listTargets: () => memory.listSynthesisTargets().map(({ agentId, store }) => ({ agentId, target: store })),
    createExecutor: () => context.deps.inference.port.createSession(() => {}, {
      modelId: SLATE_SUMMARIZATION_MODEL_ID,
      isSummarizationSession: true,
      skipLabeling: true,
    }).getExecutor(),
    report: event => context.deps.telemetry.logs.reportMemorySynthesis(memorySynthesisTelemetryReport(event)),
  })
}
