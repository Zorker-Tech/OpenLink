export interface ModelMessageForToolReferences {
  readonly role: string;
  readonly content?: unknown;
}

export interface ToolResultTextPart {
  type?: string;
  text?: string;
}

export interface ToolResultReferenceTarget {
  readonly type: string;
  readonly toolCallId: string;
  result?: unknown;
  experimental_content?: ToolResultTextPart[];
}

export function isToolResultReferenceTarget(value: unknown): value is ToolResultReferenceTarget {
  return value !== null
    && typeof value === "object"
    && "type" in value
    && value.type === "tool-result"
    && "toolCallId" in value
    && typeof value.toolCallId === "string";
}
