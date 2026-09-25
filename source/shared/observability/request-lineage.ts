/**
 * The headers that say which request a request came from.
 *
 * A request may be made on behalf of another, and the lineage travels as headers so a service can tie the two together:
 * the request it was made for, the request that started the chain, and the tool call in between when there is one. A
 * value that could not be a header is stripped of its line breaks rather than sent as it is.
 */
export interface SlateRequestLineage { readonly parentRequestId: string; readonly rootParentRequestId: string; readonly parentAgentToolCallId?: string }
export function sanitizeHeaderValue(value: string): string { return value.replace(/[\r\n]/g, ""); }
export function buildSlateRequestLineageHeaders(lineage: SlateRequestLineage | null | undefined): Record<string, string> {
  if (lineage == null) return {};
  return {
    "x-parent-request-id": sanitizeHeaderValue(lineage.parentRequestId),
    "x-root-parent-request-id": sanitizeHeaderValue(lineage.rootParentRequestId),
    ...(lineage.parentAgentToolCallId == null ? {} : { "x-parent-agent-tool-call-id": sanitizeHeaderValue(lineage.parentAgentToolCallId) }),
  };
}
