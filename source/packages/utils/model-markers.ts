/**
 * What a model name tells the platform before the model is called.
 *
 * Two things are read off the name: the tool-call markers some models emit as plain text (they have
 * to be stripped from output, or they end up in the transcript as noise), and whether the model takes
 * the large context treatment. Both are name-based because the catalogue is not available at the
 * point the decision is made.
 */

/** Markers models emit around tool calls; they are protocol noise, not content. */
export const TOOL_MARKER_TOKENS = [
  "<｜tool▁calls▁begin｜>", "<｜tool▁calls▁end｜>", "<｜tool▁call▁begin｜>", "<｜tool▁call▁end｜>",
  "<｜tool▁outputs▁begin｜>", "<｜tool▁outputs▁end｜>", "<｜tool▁output▁begin｜>", "<｜tool▁output▁end｜>",
  "<｜tool▁sep｜>", "<|redacted_tool_calls_begin|>", "<|redacted_tool_calls_end|>", "<|redacted_tool_call_begin|>",
  "<|redacted_tool_call_end|>", "<|redacted_tool_outputs_begin|>", "<|redacted_tool_outputs_end|>", "<|redacted_tool_output_begin|>",
  "<|redacted_tool_output_end|>", "<|redacted_tool_sep|>",
] as const

/**
 * Name fragments of the models that take the large context treatment. Model identifiers live in the
 * platform's model catalogue; these are the fragments that appear in them.
 */
export const LARGE_CONTEXT_MODEL_MARKERS = ["dsv3", "kimi2p5", "kimi-k2p5", "titanium"] as const

export function isLargeContextModel(modelName: string | null | undefined): boolean {
  if (!modelName) return false
  const lower = modelName.toLowerCase()
  return LARGE_CONTEXT_MODEL_MARKERS.some(marker => lower.includes(marker))
}
