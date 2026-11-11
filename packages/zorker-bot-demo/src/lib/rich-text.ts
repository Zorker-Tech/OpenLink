export const RICH_TEXT_PATTERN = /(\*\*[^*]+\*\*|@\[[^\]]+\])/g

export function stripMarkdown(content: string) {
  return content
    .replaceAll(/[*_`#|]/g, '')
    .replaceAll(/\n+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}
