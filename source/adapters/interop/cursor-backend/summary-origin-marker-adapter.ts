/** Reads the counterpart's summary marker without exposing its provider metadata shape to product code. */
function counterpartProviderOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || !("providerOptions" in value)) {
    return undefined;
  }
  const providers = value.providerOptions;
  if (providers === null || typeof providers !== "object" || !("cursor" in providers)) {
    return undefined;
  }
  const options = providers.cursor;
  return options !== null && typeof options === "object"
    ? options as Record<string, unknown>
    : undefined;
}

export function hasCounterpartSummaryOrigin(value: unknown): boolean {
  return counterpartProviderOptions(value)?.isSummary === true;
}

export function hasCounterpartSummaryMarker(value: unknown): boolean {
  return Boolean(counterpartProviderOptions(value)?.isSummary);
}

export function readCounterpartMessageTraceIds(value: unknown): {
  readonly messageId?: string;
  readonly requestId?: string;
} | undefined {
  const options = counterpartProviderOptions(value);
  if (options === undefined) return undefined;
  return {
    ...(typeof options.messageId === "string" ? { messageId: options.messageId } : {}),
    ...(typeof options.requestId === "string" ? { requestId: options.requestId } : {}),
  };
}
