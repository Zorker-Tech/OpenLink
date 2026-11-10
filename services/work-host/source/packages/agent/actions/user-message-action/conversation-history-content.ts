type DynamicValue = any;
type PartProjector = (value: DynamicValue) => DynamicValue;

type PartProjection =
  | { readonly recognized: true; readonly values: DynamicValue[] }
  | { readonly recognized: false; readonly content: DynamicValue };

function projectParts(parts: readonly DynamicValue[], projections: Readonly<Record<string, PartProjector>>): PartProjection {
  const values: DynamicValue[] = [];
  for (const part of parts) {
    const content = part.content;
    const kind = content.case;
    if (kind === undefined) continue;
    if (!Object.hasOwn(projections, kind)) return { recognized: false, content };
    values.push(projections[kind]!(content.value));
  }
  return { recognized: true, values };
}

function imagePayload(data: string): string {
  return /^data:image\/[^;,]+;base64,(.*)$/iu.exec(data)?.[1] ?? data;
}

function userImageValue(data: string, mimeType: string | undefined): string {
  if (/^data:image\/[^;,]+;base64,/iu.test(data) || mimeType === undefined) return data;
  return `data:${mimeType};base64,${data}`;
}

const USER_PARTS: Readonly<Record<string, PartProjector>> = {
  text: (value) => ({ type: "text", text: value.text }),
  image: (value) => ({ type: "image", image: userImageValue(value.data, value.mimeType), mimeType: value.mimeType }),
};

const ASSISTANT_PARTS: Readonly<Record<string, PartProjector>> = {
  text: (value) => ({ type: "text", text: value.text }),
  reasoning: (value) => ({ type: "reasoning", text: value.text, signature: value.signature }),
  redactedReasoning: (value) => ({ type: "redacted-reasoning", data: value.data }),
  toolCall: (value) => ({
    type: "tool-call",
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    args: JSON.parse(value.argsJson),
  }),
};

type ToolPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "projected"; readonly value: DynamicValue };

const TOOL_PARTS: Readonly<Record<string, PartProjector>> = {
  text: (value) => ({ kind: "text", text: value.text }),
  image: (value) => ({
    kind: "projected",
    value: { type: "image", data: imagePayload(value.data), mimeType: value.mimeType },
  }),
};

export function userContentToCore(content: readonly DynamicValue[]): DynamicValue {
  const projection = projectParts(content, USER_PARTS);
  return projection.recognized ? projection.values : projection.content;
}

export function assistantContentToCore(content: readonly DynamicValue[]): DynamicValue {
  const projection = projectParts(content, ASSISTANT_PARTS);
  if (!projection.recognized) return projection.content;
  const parts = projection.values;
  if (parts.length === 0) return "";
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
}

export function toolResultContentToCore(content: readonly DynamicValue[]): {
  readonly result: string | undefined;
  readonly experimentalContent: DynamicValue[];
} {
  const projection = projectParts(content, TOOL_PARTS);
  if (!projection.recognized) return { result: undefined, experimentalContent: [projection.content] };

  const toolParts = projection.values as ToolPart[];
  const text = toolParts.flatMap((part) => part.kind === "text" ? [part.text] : []);
  const experimentalContent = toolParts.flatMap((part) => part.kind === "projected" ? [part.value] : [{ type: "text", text: part.text }]);
  return { result: text.length === 0 ? undefined : text.join("\n"), experimentalContent };
}
