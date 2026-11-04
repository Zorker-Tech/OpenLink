import { createSlateInferenceLabelingClient } from "../../../adapters/interop/cursor-backend/slate-labeling-adapter.ts";
import type { SlateInferenceOptions } from "../../../adapters/interop/cursor-backend/cursor-inference.ts";
import type { LabelingClient } from "./slate-labeling-contracts.ts";

export function createSlateLabelingClient(options: Omit<SlateInferenceOptions, "backendUrl">): LabelingClient {
  return createSlateInferenceLabelingClient(options);
}
