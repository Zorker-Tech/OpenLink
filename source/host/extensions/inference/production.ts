/**
 * The inference, built for the host that runs it.
 *
 * The extension's own context takes factories; this is where they come from. The port is the host's inference service,
 * told how to report that the model experiment was applied; the two web tools are built from the account's own
 * credential and whatever the caller named for them.
 */

import type { SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import type { HostExtensionContext } from "../host-extensions.ts";
import { createSlateWebFetchService, createSlateWebSearchService } from "../../../adapters/interop/agent/slate-web-tools-adapter.ts";
import { createHostInference } from "./inference-service.ts";
import type { InferenceExtensionContext } from "./extension.ts";

type HostInferenceContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"];
};

type RequestIdOption = { readonly onRequestId?: ((requestId: string) => void) | null };

function requestIdOption(request: RequestIdOption): { readonly onRequestId?: (requestId: string) => void } {
  return request.onRequestId == null ? {} : { onRequestId: request.onRequestId };
}

function webSearchFor(
  auth: InferenceExtensionContext["deps"]["auth"],
  input: unknown,
) {
  const request = input as { readonly modelId: string } & RequestIdOption;
  return createSlateWebSearchService({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    modelId: request.modelId,
    ...requestIdOption(request),
  });
}

function webFetchFor(auth: InferenceExtensionContext["deps"]["auth"], input: unknown) {
  return createSlateWebFetchService({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    ...requestIdOption(input as RequestIdOption),
  });
}

function inferencePortFor(context: HostInferenceContext, onApplied: () => void) {
  return createHostInference({
    auth: context.deps.auth,
    experiments: context.deps.experiments,
    settings: context.deps.settings,
    onModelExperimentApplied: onApplied,
  });
}

export function createInferenceProductionExtras(context: HostInferenceContext): Omit<InferenceExtensionContext, "deps"> {
  const auth = context.deps.auth;
  return {
    createPort: (onApplied) => inferencePortFor(context, onApplied),
    createWebSearch: (input) => webSearchFor(auth, input),
    createWebFetch: (input) => webFetchFor(auth, input),
  };
}

export type InferenceModelSelection = SlateAgentModelSelection;
