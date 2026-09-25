/**
 * Rules that apply only to some people.
 *
 * A rule file can carry `metadata.scopedTo` in its frontmatter — a list of email addresses — and it
 * applies to those people only. The frontmatter has to be read without a YAML parser (rule files are
 * user-edited and often hand-written), so the two shapes people actually write are supported: an
 * inline list and an indented block under `metadata:`. Anything else yields no scoping, which means
 * the rule applies to everyone — the safe direction for a rule that is meant to be read.
 */

function normalizeEmailForMatch(raw: string): string {
  return raw.trim().toLowerCase()
}

function getFrontmatterLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  const openingFence = normalized.match(/^(?:\uFEFF|\s)*---\n/)
  if (openingFence === null) return []
  const start = openingFence[0].length
  const end = normalized.indexOf("\n---", start)
  return end === -1 ? [] : normalized.slice(start, end).split("\n")
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0
}

function normalizeScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? trimmed.slice(1, -1).trim() : trimmed
}

function parseInlineList(value: string): string[] {
  const trimmed = normalizeScalar(value)
  const list = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  return list.split(",").map(normalizeScalar).filter(entry => entry.length > 0)
}

function parseIndentedList(lines: readonly string[], start: number, parentIndent: number): string[] {
  const entries: string[] = []
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] as string
    if (line.trim().length === 0) continue
    if (indentation(line) < parentIndent) break
    const item = line.match(/^\s*-\s*(.+)$/)
    if (item?.[1] === undefined) break
    entries.push(normalizeScalar(item[1]))
  }
  return entries.filter(entry => entry.length > 0)
}

/** Finds `scopedTo`, either as `metadata.scopedTo:` or nested under `metadata:`. */
function locateScopedTo(lines: readonly string[]): { index: number; inlineValue: string } | undefined {
  let metadataIndent: number | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const flat = line.match(/^\s*metadata\.scopedTo\s*:\s*(.*)$/)
    if (flat?.[1] !== undefined) return { index, inlineValue: flat[1] }
    const metadata = line.match(/^(\s*)metadata\s*:\s*$/)
    if (metadata?.[1] !== undefined) {
      metadataIndent = metadata[1].length
      continue
    }
    if (metadataIndent === undefined) continue
    if (line.trim().length > 0 && indentation(line) <= metadataIndent) {
      metadataIndent = undefined
      continue
    }
    const nested = line.match(/^\s*scopedTo\s*:\s*(.*)$/)
    if (nested?.[1] !== undefined) return { index, inlineValue: nested[1] }
  }
  return undefined
}

export function parseScopedToFromFrontmatter(text: string): string[] {
  const lines = getFrontmatterLines(text)
  const scopedTo = locateScopedTo(lines)
  if (scopedTo === undefined) return []
  if (scopedTo.inlineValue.trim().length > 0) return parseInlineList(scopedTo.inlineValue)
  return parseIndentedList(lines, scopedTo.index, indentation(lines[scopedTo.index] as string))
}

export interface ScopedItem {
  scopedTo?: readonly string[]
  frontmatter?: string
  content?: string
}

/** What a rule is scoped to: an explicit list, or whatever its own text says. */
export function getEffectiveScopedTo(item: ScopedItem): readonly string[] {
  if (item.scopedTo !== undefined && item.scopedTo.length > 0) return item.scopedTo
  const raw = item.frontmatter !== undefined && item.frontmatter.length > 0 ? item.frontmatter : item.content
  return raw !== undefined && raw.length > 0 ? parseScopedToFromFrontmatter(raw) : []
}

/** Keeps the rules that apply to this actor, and the ones that apply to everyone. */
export function filterByActorIdentity<T extends ScopedItem>(
  items: readonly T[],
  actor: { email: string } | undefined,
): T[] {
  return items.filter(item => {
    const scopedTo = getEffectiveScopedTo(item)
    return scopedTo.length === 0 ||
      (actor !== undefined && scopedTo.some(email => normalizeEmailForMatch(email) === normalizeEmailForMatch(actor.email)))
  })
}
