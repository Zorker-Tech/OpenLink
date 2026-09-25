/**
 * The annotations an MCP tool declares about itself, bounded for the wire.
 *
 * A tool may describe itself with a title and four hints; the title is cut to a length that fits, anything that is not
 * a string or a boolean is dropped rather than guessed at, and a tool that said nothing carries no annotations at all.
 */
export const MAX_TOOL_ANNOTATION_TITLE_LENGTH = 256;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export function toolAnnotationsJsonField(annotations: ToolAnnotations | undefined): { annotationsJson?: string } {
  if (annotations === undefined) return {};
  const bounded: ToolAnnotations = {};
  if (typeof annotations.title === "string" && annotations.title.length > 0) {
    bounded.title = annotations.title.slice(0, MAX_TOOL_ANNOTATION_TITLE_LENGTH);
  }
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof annotations[key] === "boolean") bounded[key] = annotations[key];
  }
  return Object.keys(bounded).length === 0 ? {} : { annotationsJson: JSON.stringify(bounded) };
}
