/** The content search as a host extension: the service is started from here and stopped with the host. */
import { join } from "node:path";
import { createDeadlinePolicy, realClock } from "../scheduling.ts";
import { defineHostExtension } from "../host-extensions.ts";
import { subscribeTranscriptMutations } from "../../transcript/transcript-mutation-events.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { getSlateAgentsRootDir } from "../../storage/agent-paths.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SEARCH_INDEX_FILENAME } from "./search-index-db.ts";
import { SlateSearchIndexService, SEARCH_INDEX_DISPOSE_TIMEOUT_MS, type TranscriptMutation } from "./search-index-service.ts";
import { bindContentSearchGateLifecycle, type ContentSearchFeatureGate } from "./content-search-gate-lifecycle.ts";
import { createContentSearchExtensionApi } from "./content-search-extension-api.ts";

export const GLOBAL_SEARCH_GATE = "slate_global_search";

export const contentSearchExtension = defineHostExtension({
  id: HostExtensions.ContentSearch,
  dependencies: [HostExtensions.Experiments, HostExtensions.Telemetry],
  start: (context) => {
    const deps = context.deps as {
      experiments: { checkFeatureGate(name: string): boolean; getFeatureGateProperty(name: string): ContentSearchFeatureGate };
      telemetry: { logs: { reportSearchIndexHealth(value: Record<string, unknown>): void } };
    };
    const index = new SlateSearchIndexService({
      indexDbPath: join(getSlateRootDir(), SEARCH_INDEX_FILENAME),
      agentsRootDir: getSlateAgentsRootDir(),
      disposeDeadline: createDeadlinePolicy(realClock, { name: "slate-content-search-dispose", timeoutMs: SEARCH_INDEX_DISPOSE_TIMEOUT_MS }),
      report: (value) => deps.telemetry.logs.reportSearchIndexHealth(value)
    });
    const subscribe = subscribeTranscriptMutations as unknown as (listener: (mutation: TranscriptMutation) => void) => () => void;
    const gate = deps.experiments.getFeatureGateProperty(GLOBAL_SEARCH_GATE);
    bindContentSearchGateLifecycle({
      gate,
      index,
      subscribeMutations: subscribe,
      onStop: teardown => context.onStop(teardown),
    });
    return createContentSearchExtensionApi(index, () =>
      deps.experiments.checkFeatureGate(GLOBAL_SEARCH_GATE));
  }
});
