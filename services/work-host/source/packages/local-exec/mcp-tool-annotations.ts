/** The annotations a tool may show about itself, limited to a small set of useful facts. */

/** Maximum annotation title length retained by the catalog. */
export const MAX_TOOL_ANNOTATION_TITLE_LENGTH = 256;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** The four hints a tool can declare about itself. */
type BooleanHint = "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint";

/** The hints in the order they travel, which is not necessarily the order the caller wrote them in. */
const BOOLEAN_HINTS: readonly BooleanHint[] = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

/** A missing title stays missing; a longer one is shortened to the catalog's limit. */
function boundedTitleOf(title: unknown): string | undefined {
  if (typeof title !== "string" || title.length === 0) return undefined;
  return title.slice(0, MAX_TOOL_ANNOTATION_TITLE_LENGTH);
}

/** Validates the title and Boolean hints before a descriptor leaves the filesystem writer. */
export function normalizeToolAnnotations(annotations: ToolAnnotations | undefined): ToolAnnotations | undefined {
  if (annotations === undefined) return undefined;
  const normalized: ToolAnnotations = {};
  const title = boundedTitleOf(annotations.title);
  if (title !== undefined) normalized.title = title;
  for (const hint of BOOLEAN_HINTS) {
    const declared = annotations[hint];
    if (typeof declared === "boolean") normalized[hint] = declared;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}
