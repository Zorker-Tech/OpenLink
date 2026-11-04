import { parseScopedToFromFrontmatter } from "./rule-scope-frontmatter.ts"

export { parseScopedToFromFrontmatter } from "./rule-scope-frontmatter.ts"

export interface ScopedItem {
  readonly scopedTo?: readonly string[]
  readonly frontmatter?: string
  readonly content?: string
}

function actorAddress(address: string): string {
  return address.trim().toLowerCase()
}

export function getEffectiveScopedTo(item: ScopedItem): readonly string[] {
  if (item.scopedTo !== undefined && item.scopedTo.length > 0) return item.scopedTo
  const text = item.frontmatter !== undefined && item.frontmatter.length > 0 ? item.frontmatter : item.content
  return text === undefined || text.length === 0 ? [] : parseScopedToFromFrontmatter(text)
}

/** Keep shared guidance and guidance that names the current actor. */
export function filterByActorIdentity<T extends ScopedItem>(
  items: readonly T[],
  actor: { readonly email: string } | undefined,
): T[] {
  const normalizedActor = actor === undefined ? undefined : actorAddress(actor.email)
  return items.filter((item) => {
    const targets = getEffectiveScopedTo(item)
    if (targets.length === 0) return true
    return normalizedActor !== undefined && targets.some((target) => actorAddress(target) === normalizedActor)
  })
}
