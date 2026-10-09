/**
 * The inference, built for the host that runs it.
 *
 * The extension's own context takes factories; this is where they come from. The port is the host's inference service,
 * told how to report that the model experiment was applied; the two web tools are built from the account's own
 * credential and whatever the caller named for them.
 */

import type { SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import type { HostExtensionContext } from "../host-extensions.ts";
import { createCursorWebFetchService, createCursorWebSearchService } from "./cursor-web-tools.ts";
import { createHostInference } from "./inference-service.ts";
import type { InferenceExtensionContext } from "./extension.ts";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"];
};

export function createInferenceProductionExtras(context: ProductionContext): Omit<InferenceExtensionContext, "deps"> {
  const auth = context.deps.auth;
  return {
    createPort(onModelExperimentApplied) {
      return createHostInference({
        auth,
        experiments: context.deps.experiments,
        settings: context.deps.settings,
        onModelExperimentApplied,
      });
    },
    createWebSearch(args) {
      const request = args as { modelId: string; onRequestId?: (requestId: string) => void };
      return createCursorWebSearchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        modelId: request.modelId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
    createWebFetch(args) {
      const request = args as { onRequestId?: (requestId: string) => void };
      return createCursorWebFetchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
  };
}

export type InferenceModelSelection = SlateAgentModelSelection;
