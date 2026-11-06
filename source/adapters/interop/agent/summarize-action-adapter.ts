/** Reads the provider-only marker that says a user message carries a prior summary. */
export function isInteropSummaryPromptMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false
  const fields = message as {
    readonly role?: unknown
    readonly providerOptions?: {
      readonly cursor?: { readonly isSummary?: unknown } | undefined
    } | undefined
  }
  return fields.role === "user" && fields.providerOptions?.cursor?.isSummary === true
}
