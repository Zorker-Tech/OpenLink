/** External tool-call markers that can leak into streamed tool arguments. */
export const INTEROP_TOOL_MARKER_TOKENS = [
  "<｜tool▁calls▁begin｜>", "<｜tool▁calls▁end｜>", "<｜tool▁call▁begin｜>", "<｜tool▁call▁end｜>",
  "<｜tool▁outputs▁begin｜>", "<｜tool▁outputs▁end｜>", "<｜tool▁output▁begin｜>", "<｜tool▁output▁end｜>",
  "<｜tool▁sep｜>", "<|redacted_tool_calls_begin|>", "<|redacted_tool_calls_end|>", "<|redacted_tool_call_begin|>",
  "<|redacted_tool_call_end|>", "<|redacted_tool_outputs_begin|>", "<|redacted_tool_outputs_end|>", "<|redacted_tool_output_begin|>",
  "<|redacted_tool_output_end|>", "<|redacted_tool_sep|>",
] as const

export function stripInteropToolMarkerTokens(input: string): {
  readonly text: string
  readonly removedMarkers: readonly string[]
} {
  let text = input
  const removedMarkers: string[] = []
  for (const marker of INTEROP_TOOL_MARKER_TOKENS) {
    if (!text.includes(marker)) continue
    text = text.replaceAll(marker, "")
    removedMarkers.push(marker)
  }
  return { text, removedMarkers }
}
