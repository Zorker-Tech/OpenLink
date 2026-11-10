import { routedMcpRecord } from "./routed-mcp-shapes.ts";

/** Project a routed provider answer into the text, image and structured MCP result pieces. */
export function projectRoutedMcpResult(value: unknown): Record<string, unknown> {
  const root = routedMcpRecord(value);
  const result = routedMcpRecord(root?.result);
  if (result?.case !== "success") {
    const detail = routedMcpRecord(result?.value);
    const text = typeof detail?.error === "string" ? detail.error : JSON.stringify(value);
    return { isError: true, content: [{ type: "text", text }] };
  }

  const success = routedMcpRecord(result.value);
  const content = projectContentItems(success?.content);
  const structuredContent = success?.structuredContent;
  return {
    isError: success?.isError === true,
    content: content.length === 0 ? [{ type: "text", text: JSON.stringify(success ?? value) }] : content,
    ...(structuredContent == null ? {} : { structuredContent }),
  };
}

function projectContentItems(rawItems: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawItems)) return [];

  return rawItems.flatMap((raw: unknown): Record<string, unknown>[] => {
    const item = routedMcpRecord(raw);
    const carrier = routedMcpRecord(item?.content);
    const payload = routedMcpRecord(carrier?.value);
    if (carrier?.case === "text" && typeof payload?.text === "string") {
      return [{ type: "text", text: payload.text }];
    }
    if (carrier?.case === "image" && payload?.data != null && typeof payload.mimeType === "string") {
      return [{ type: "image", data: payload.data, mimeType: payload.mimeType }];
    }
    return [];
  });
}
