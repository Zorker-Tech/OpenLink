/**
 * Why something was canceled, flattened into attributes a log line or a span can carry.
 *
 * Abort reasons are `unknown` by nature — a `DOMException`, an `Error`, a string, or nothing at
 * all — so every consumer that reports them needs the same small normalization.
 */

export type AbortReasonSummary =
  | { readonly abortReasonType: "error"; readonly abortReasonName: string; readonly abortReasonMessage: string }
  | { readonly abortReasonType: "string"; readonly abortReasonMessage: string }
  | { readonly abortReasonType: "undefined" }
  | { readonly abortReasonType: string }

export function summarizeAbortReason(value: unknown): AbortReasonSummary {
  if (value instanceof Error) {
    return { abortReasonType: "error", abortReasonName: value.name, abortReasonMessage: value.message }
  }
  if (typeof value === "string") {
    return { abortReasonType: "string", abortReasonMessage: value }
  }
  if (value === undefined) {
    return { abortReasonType: "undefined" }
  }
  return { abortReasonType: typeof value }
}
