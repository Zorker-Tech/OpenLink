/**
 * Putting a tool call's reference on the result the model reads.
 *
 * The model is told about tool calls by reference, so the reference has to be attached to the result
 * rather than only to the call: a result that arrives without one cannot be referred to later. It is
 * appended to the result's text, or added as a text part when the result has none — and never twice, so
 * a result that already ends in its tag is left alone.
 *
 * Only a session where the model is talking to a subagent directly is tagged, because that is the
 * conversation in which references are used.
 */

import { getIsDirectMetaParentChildSubagentFromContext } from "../utils/request-scope.ts"
import {
  attachToolReferencesToModelResults,
} from "./tool-result-reference-projection.ts";
import type { ModelMessageForToolReferences } from "./tool-result-reference-contracts.ts";

export function attachToolReferenceHints(
  messages: readonly ModelMessageForToolReferences[],
): void {
  attachToolReferencesToModelResults(messages);
}

export function shouldExposeToolReferencesInCurrentContext(
  ctx: Parameters<typeof getIsDirectMetaParentChildSubagentFromContext>[0],
): boolean {
  return getIsDirectMetaParentChildSubagentFromContext(ctx)
}
