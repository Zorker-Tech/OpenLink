/** The memory this build offers, assembled from what the platform has.

 * Which model reviews what is remembered, which session it runs in and how its answer is read are decided here, so the
 * rest of the host asks for the memory rather than for the parts it is made of. */
import type { HostExtensionContext } from "../extensions/host-extensions.ts";
import {
  createDeadlinePolicy,
  createRealDebouncePolicy,
  createRealPollingPolicy,
  createRealRetryPolicy,
  realClock
} from "../extensions/scheduling.ts";
import { getSlateAgentsRootDir } from "../storage/agent-paths.ts";
import { getSlateRootDir } from "../host-paths.ts";
import { SLATE_SUMMARIZATION_MODEL_ID } from "../../shared/agents/slate-agent-model.ts";
import type { MemoryExtensionContext } from "./extension.ts";
import {
  MEMORY_CHANGE_DEBOUNCE_MS,
  type MemoryService
} from "./memory-service.ts";
import {
  MEMORY_SYNTHESIS_DEADLINE_MS,
  MEMORY_SYNTHESIS_DEBOUNCE_MS,
  MEMORY_SYNTHESIS_POLL_INTERVAL_MS,
  MEMORY_SYNTHESIS_RETRY_ATTEMPTS,
  MEMORY_SYNTHESIS_RETRY_INITIAL_MS,
  MEMORY_SYNTHESIS_RETRY_MAX_MS,
  MemorySynthesisService,
  memorySynthesisTelemetryReport
} from "./memory-synthesis-service.ts";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: MemoryExtensionContext["deps"];
};

/** Artifact construction at host-main.cjs:626827-626891. */
export function createMemoryProductionExtras(
  context: ProductionContext
): Omit<MemoryExtensionContext, "deps" | "onStop"> {
  return {
    slateRoot: getSlateRootDir(),
    agentsRootDir: getSlateAgentsRootDir(),
    debounce: createRealDebouncePolicy({
      name: "slate-memory-change",
      delayMs: MEMORY_CHANGE_DEBOUNCE_MS
    }),
    createSynthesis(service: MemoryService) {
      return new MemorySynthesisService({
        debounce: createRealDebouncePolicy({
          name: "slate-memory-synthesis",
          delayMs: MEMORY_SYNTHESIS_DEBOUNCE_MS
        }),
        deadline: createDeadlinePolicy(realClock, {
          name: "slate-memory-synthesis-inference",
          timeoutMs: MEMORY_SYNTHESIS_DEADLINE_MS
        }),
        polling: createRealPollingPolicy({
          name: "slate-memory-temporal-refresh",
          intervalMs: MEMORY_SYNTHESIS_POLL_INTERVAL_MS
        }),
        retry: createRealRetryPolicy({
          name: "slate-memory-synthesis-retry",
          maxAttempts: MEMORY_SYNTHESIS_RETRY_ATTEMPTS,
          initialDelayMs: MEMORY_SYNTHESIS_RETRY_INITIAL_MS,
          maxDelayMs: MEMORY_SYNTHESIS_RETRY_MAX_MS
        }),
        getTarget: agentId => service.synthesisTargetForAgent(agentId),
        listTargets: () => service.listSynthesisTargets().map(({ agentId, store }) => ({
          agentId,
          target: store
        })),
        createExecutor: () => context.deps.inference.port.createSession(() => {}, {
          modelId: SLATE_SUMMARIZATION_MODEL_ID,
          isSummarizationSession: true,
          skipLabeling: true
        }).getExecutor(),
        report: event => context.deps.telemetry.logs.reportMemorySynthesis(memorySynthesisTelemetryReport(event))
      });
    }
  };
}
