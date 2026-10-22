/**
 * The plain text a markdown document stands for.
 *
 * A preview shows what a document says rather than how it is written, so the transforms strip the marks: code fences,
 * emphasis, links and images, headings, quotes, list markers, and the math delimiters a document may use.
 *
 * The order matters — an image has to be recognised before the link inside it, and a bold run before the single
 * asterisks it is made of — so the transforms are one list applied in order rather than a set of independent rules.
 */
type PreviewTransform = readonly [pattern: RegExp, replacement: string];

/** The marks a preview does not show, in the order they have to be removed. */
const MARKS: readonly PreviewTransform[] = [
  [/`+/g, ""],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/\$\$((?:[^$\\]|\\[\s\S])+)\$\$/g, "$1"],
  [/\\\(([\s\S]+?)\\\)/g, "$1"],
  [/\\\[([\s\S]+?)\\\]/g, "$1"],
  [/\\\$/g, "$"],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ""],
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/~~([^~]+)~~/g, "$1"],
  [/\*([^*\n]+)\*/g, "$1"],
  [/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1"],
  [/\|/g, " "],
];

/** The marks removed, in order, leaving one run of text: applying the list is what keeps each rule where it belongs. */
export function previewTextOf(input: string): string {
  const stripped = MARKS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
  return stripped.replace(/\s+/g, " ").trim();
}
