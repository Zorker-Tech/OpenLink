/**
 * The headers that say which request a request came from.
 *
 * A request may be made on behalf of another, and the lineage travels as headers so a service can tie the two together:
 * the request it was made for, the request that started the chain, and the tool call in between when there is one. A
 * value that could not be a header is stripped of its line breaks rather than sent as it is.
 */

/** What a request says about the request it came from. */
export interface SlateRequestLineage {
  readonly parentRequestId: string;
  readonly rootParentRequestId: string;
  readonly parentAgentToolCallId?: string;
}

/** The header that names the request this one was made for. */
const PARENT_REQUEST_HEADER = "x-parent-request-id";

/** The header that names the request the chain started with. */
const ROOT_PARENT_REQUEST_HEADER = "x-root-parent-request-id";

/** The header that names the tool call in between, when there is one. */
const PARENT_AGENT_TOOL_CALL_HEADER = "x-parent-agent-tool-call-id";

/** A header value may not carry a line break: it would end the header and start another. */
const LINE_BREAKS = /[\r\n]/g;

/** A value that is safe to put in a header, with its line breaks taken out. */
export const sanitizeHeaderValue = (value: string): string => value.replace(LINE_BREAKS, "");

/** The lineage headers a request carries, or none when it came from nowhere. */
export const buildSlateRequestLineageHeaders = (lineage: SlateRequestLineage | null | undefined): Record<string, string> => {
  if (lineage == null) return {};
  const headers: Record<string, string> = {
    [PARENT_REQUEST_HEADER]: sanitizeHeaderValue(lineage.parentRequestId),
    [ROOT_PARENT_REQUEST_HEADER]: sanitizeHeaderValue(lineage.rootParentRequestId),
  };
  const toolCallId = lineage.parentAgentToolCallId;
  if (toolCallId != null) headers[PARENT_AGENT_TOOL_CALL_HEADER] = sanitizeHeaderValue(toolCallId);
  return headers;
};
