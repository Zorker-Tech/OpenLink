/** Compatibility forwarding for callers that still import the old interop path. */
export {
  usageCountsFrom,
  wrapExecutorWithUsageRecording,
  type SlateInferenceUsage,
} from "../../../host/extensions/inference/inference-usage-recording.ts"
