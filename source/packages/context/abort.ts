/**
 * Why something was canceled, flattened into attributes a log line or a span can carry.
 *
 * Abort reasons are `unknown` by nature — a `DOMException`, an `Error`, a string, or nothing at
 * all — so every consumer that reports them needs the same small normalization.
 */

export type AbortReasonDescription =
  | { readonly abortReasonType: "error"; readonly abortReasonName: string; readonly abortReasonMessage: string }
  | { readonly abortReasonType: "string"; readonly abortReasonMessage: string }
  | { readonly abortReasonType: "undefined" }
  | { readonly abortReasonType: string }

export function getAbortReasonInfo(reason: unknown): AbortReasonDescription {
  if (reason instanceof Error) {
    return { abortReasonType: "error", abortReasonName: reason.name, abortReasonMessage: reason.message }
  }
  if (typeof reason === "string") {
    return { abortReasonType: "string", abortReasonMessage: reason }
  }
  if (reason === undefined) {
    return { abortReasonType: "undefined" }
  }
  return { abortReasonType: typeof reason }
}
