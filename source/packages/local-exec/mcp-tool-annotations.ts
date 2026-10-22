/**
 * The annotations an MCP tool declares about itself, bounded for the wire.
 *
 * A tool may describe itself with a title and four hints; the title is cut to a length that fits, anything that is not
 * a string or a boolean is dropped rather than guessed at, and a tool that said nothing carries no annotations at all.
 */

/** The longest title that travels to the wire, in characters. */
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

/** The title as it travels: a title that says nothing is left off, and a long one is cut to the wire's length. */
function wireTitleOf(title: unknown): string | undefined {
  if (typeof title !== "string" || title.length === 0) return undefined;
  return title.slice(0, MAX_TOOL_ANNOTATION_TITLE_LENGTH);
}

/** The annotations a tool descriptor carries, as one JSON field, or nothing when the tool said nothing. */
export function toolAnnotationsJsonField(annotations: ToolAnnotations | undefined): { annotationsJson?: string } {
  if (annotations === undefined) return {};
  const wireAnnotations: ToolAnnotations = {};
  const title = wireTitleOf(annotations.title);
  if (title !== undefined) wireAnnotations.title = title;
  for (const hint of BOOLEAN_HINTS) {
    const declared = annotations[hint];
    if (typeof declared === "boolean") wireAnnotations[hint] = declared;
  }
  if (Object.keys(wireAnnotations).length === 0) return {};
  return { annotationsJson: JSON.stringify(wireAnnotations) };
}
