/**
 * The plain text a markdown document stands for.
 *
 * A preview shows what a document says rather than how it is written, so the transforms strip the marks: code fences,
 * emphasis, links and images, headings, quotes, list markers, and the math delimiters a document may use.
 *
 * The order matters — an image has to be recognised before the link inside it, and a bold run before the single
 * asterisks it is made of — so the transforms are one list applied in order rather than a set of independent rules.
 */
type PreviewTransform = (text: string) => string

const previewTransforms: readonly PreviewTransform[] = [
  text => text.replace(/`+/g, ""),
  text => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"),
  text => text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"),
  text => text.replace(/\$\$((?:[^$\\]|\\[\s\S])+)\$\$/g, "$1"),
  text => text.replace(/\\\(([\s\S]+?)\\\)/g, "$1"),
  text => text.replace(/\\\[([\s\S]+?)\\\]/g, "$1"),
  text => text.replace(/\\\$/g, "$"),
  text => text.replace(/^\s{0,3}#{1,6}\s+/gm, ""),
  text => text.replace(/^\s{0,3}>\s?/gm, ""),
  text => text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ""),
  text => text.replace(/\*\*([^*]+)\*\*/g, "$1"),
  text => text.replace(/__([^_]+)__/g, "$1"),
  text => text.replace(/~~([^~]+)~~/g, "$1"),
  text => text.replace(/\*([^*\n]+)\*/g, "$1"),
  text => text.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1"),
  text => text.replace(/\|/g, " "),
]

export function previewTextOf(input: string): string {
  const rendered = previewTransforms.reduce((text, transform) => transform(text), input)
  return rendered.replace(/\s+/g, " ").trim()
}
