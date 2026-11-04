/**
 * The images an MCP tool result carries.
 *
 * A result's images are persisted where the platform keeps them, and what was saved is added to the result as a text
 * item saying where it went and how to show it — so an image the model already has on disk does not have to be carried
 * through the tool result again. An image that cannot be persisted is left as it was.
 */
import { generatedMcpResultFactory } from "./mcp-result-factory.ts";
import { describeSavedImage } from "../../../shared/node/mcp/saved-image-notice.ts";

export interface McpContentItem {
  content: { case: string | undefined; value?: any };
}
export interface McpResultLike {
  result: { case: string | undefined; value?: any };
}
export interface McpResultFactory {
  textItem(text: string): McpContentItem;
  success<T extends McpResultLike>(original: T, content: McpContentItem[]): T;
}

export async function augmentMcpResultWithSavedImages<T extends McpResultLike>(
  result: T,
  persistImage: (
    data: string,
    mimeType: string,
  ) => Promise<{ fileUrl: string; width?: number; height?: number } | null>,
  factory: McpResultFactory = generatedMcpResultFactory,
): Promise<T> {
  if (result.result.case !== "success") return result;
  const success = result.result.value as { content: McpContentItem[] };
  if (!success.content.some((item) => item.content.case === "image"))
    return result;
  const augmented: McpContentItem[] = [];
  for (const item of success.content) {
    augmented.push(item);
    if (item.content.case !== "image") continue;
    const image = item.content.value as { data: string; mimeType: string };
    if (image.data.length === 0) continue;
    let saved = null;
    try {
      saved = await persistImage(image.data, image.mimeType);
    } catch {}
    if (saved != null)
      augmented.push(factory.textItem(describeSavedImage(saved)));
  }
  return factory.success(result, augmented);
}
