import {
  createToolCallReferenceId,
  isValidPromptReferenceId,
  renderToolCallIdTag,
} from "./prompt-reference-contract.ts";
import {
  isToolResultReferenceTarget,
  type ModelMessageForToolReferences,
  type ToolResultReferenceTarget,
} from "./tool-result-reference-contracts.ts";

function alreadyEndsWithReference(text: string, tag: string): boolean {
  return text.trimEnd().endsWith(tag);
}

function addReferenceSuffix(text: string, tag: string): string {
  return alreadyEndsWithReference(text, tag) ? text : `${text}\n${tag}`;
}

function referenceTagFor(callId: string): string | undefined {
  const identifier = createToolCallReferenceId(callId);
  return isValidPromptReferenceId(identifier) ? renderToolCallIdTag(identifier) : undefined;
}

function attachToResultValue(part: ToolResultReferenceTarget, tag: string): void {
  if (typeof part.result === "string") {
    part.result = addReferenceSuffix(part.result, tag);
  } else if (part.result === undefined || part.result === null) {
    part.result = tag;
  }
}

function attachToLastTextPart(part: ToolResultReferenceTarget, tag: string): void {
  if (!Array.isArray(part.experimental_content)) return;

  for (let position = part.experimental_content.length - 1; position >= 0; position -= 1) {
    const candidate = part.experimental_content[position];
    if (candidate?.type !== "text" || typeof candidate.text !== "string") continue;
    candidate.text = addReferenceSuffix(candidate.text, tag);
    return;
  }

  part.experimental_content.push({ type: "text", text: tag });
}

function annotateToolResult(part: ToolResultReferenceTarget): void {
  const tag = referenceTagFor(part.toolCallId);
  if (tag === undefined) return;
  attachToResultValue(part, tag);
  attachToLastTextPart(part, tag);
}

export function attachToolReferencesToModelResults(
  messages: readonly ModelMessageForToolReferences[],
): void {
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const candidate of message.content) {
      if (isToolResultReferenceTarget(candidate)) annotateToolResult(candidate);
    }
  }
}
