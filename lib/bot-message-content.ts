export type MessageMention = { id: string; name: string; workAgentId?: string }

export type MessageTextPart =
  | { kind: 'text' | 'link'; value: string }
  | { kind: 'mention'; value: string; id: string }

function appendText(parts: MessageTextPart[], value: string) {
  if (!value) return
  const previous = parts.at(-1)
  if (previous?.kind === 'text') previous.value += value
  else parts.push({ kind: 'text', value })
}

export function createMessageMentionMatcher(members: readonly MessageMention[]) {
  const names = new Map<string, Set<string>>()
  for (const member of members) {
    const name = member.name.trim().toLowerCase()
    const handles = new Set([name, name.replace(/\s+/g, ''), name.split(/\s+/)[0], member.workAgentId?.toLowerCase()])
    for (const handle of handles) {
      if (!handle) continue
      const ids = names.get(handle) ?? new Set<string>()
      ids.add(member.id)
      names.set(handle, ids)
    }
  }
  const handles = [...names.keys()]
    .sort((first, second) => second.length - first.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = handles.length
    ? new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_@])(@(?:${handles.join('|')}))(?=$|[^\\p{L}\\p{M}\\p{N}_])`, 'giu')
    : null

  return (value: string): MessageTextPart[] => {
    const parts: MessageTextPart[] = []
    let cursor = 0
    for (const match of pattern ? value.matchAll(pattern) : []) {
      const label = match[1]!
      const candidates = names.get(label.slice(1).toLowerCase())
      const id = candidates?.size === 1 ? candidates.values().next().value : undefined
      if (!id) continue
      const start = match.index + match[0].length - label.length
      appendText(parts, value.slice(cursor, start))
      parts.push({ kind: 'mention', value: label, id })
      cursor = start + label.length
    }
    appendText(parts, value.slice(cursor))
    return parts
  }
}

function trimUrl(value: string): string {
  let url = value.replace(/[.,!?:;\u3002\uff0c\uff01\uff1f\uff1a\uff1b]+$/u, '')
  while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1)
  return url
}

export function splitMessagePrompt(value: string, matchMentions: ReturnType<typeof createMessageMentionMatcher>): MessageTextPart[] {
  const parts: MessageTextPart[] = []
  let cursor = 0
  for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>"'\u3002\uff0c\uff01\uff1f]+/giu)) {
    const url = trimUrl(match[0])
    if (!URL.canParse(url)) continue
    parts.push(...matchMentions(value.slice(cursor, match.index)), { kind: 'link', value: url })
    cursor = match.index + url.length
  }
  parts.push(...matchMentions(value.slice(cursor)))
  return parts
}
