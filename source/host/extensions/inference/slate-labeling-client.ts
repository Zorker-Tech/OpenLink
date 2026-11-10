import { createSlateInferenceLabelingClient } from "../../../adapters/interop/slate-backend/slate-labeling-adapter.ts";
import type { SlateInferenceOptions } from "../../../adapters/interop/slate-backend/slate-backend-client.ts";
import type { LabelingClient } from "./slate-labeling-contracts.ts";

export function createSlateLabelingClient(options: Omit<SlateInferenceOptions, "backendUrl">): LabelingClient {
  return createSlateInferenceLabelingClient(options);
}
