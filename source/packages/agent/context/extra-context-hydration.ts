/**
 * The extra context the user attached, deduplicated.
 *
 * Extra context is free-form text the user added — a note, a snippet, a passage — and it can arrive
 * inline or as a blob. Both are collected into one list, and a value that appears twice is included
 * once: the same text twice in a prompt is noise, and the user cannot tell it was deduplicated.
 *
 * An entry with nothing in it is skipped rather than treated as empty context, and a blob that cannot be
 * found is an error rather than a silent omission — the user attached something and would expect it to
 * be there.
 */

export interface ExtraContextBlobStore<Context = unknown> {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
}

export type SlateExtraContextEntry =
  | { readonly kind: "inline-text"; readonly text: string }
  | { readonly kind: "stored-text"; readonly blobId: Uint8Array }
  | { readonly kind: "empty" }

export interface SelectedExtraContext {
  readonly entries: readonly SlateExtraContextEntry[]
  readonly inlineText: readonly string[]
}

/** One piece of text read out of an entry, or nothing when the entry pointed at nothing. */
async function readEntry<Context>(
  ctx: Context,
  entry: SlateExtraContextEntry,
  blobStore: ExtraContextBlobStore<Context> | undefined,
): Promise<string | undefined> {
  if (entry.kind === "empty") return undefined
  if (entry.kind === "inline-text") return entry.text
  if (!blobStore) throw new Error("Blob store is required to hydrate extra context blob")
  const blob = await blobStore.getBlob(ctx, entry.blobId)
  if (!blob) throw new Error("Extra context blob not found")
  return new TextDecoder().decode(blob)
}

/**
 * A list that takes a value once.
 *
 * Nothing to add is not an error: an entry that carried no text and a value already in the list are both simply not
 * added, which is what makes the list safe to read as the prompt's extra context.
 */
function uniqueTexts(): { readonly add: (value: string | undefined) => void; readonly values: string[] } {
  const seen = new Set<string>()
  const values: string[] = []
  return {
    add: (value) => {
      if (value === undefined || value.length === 0 || seen.has(value)) return
      seen.add(value)
      values.push(value)
    },
    values,
  }
}

/**
 * The extra context for a prompt: every entry read, then anything already spelled out, each value once and in the order
 * it was attached.
 *
 * The entries are read at the same time — a blob store may be a worker call — and put in the list in the order they were
 * given, so a slow entry cannot reorder the user's context.
 */
export async function hydrateSelectedExtraContext<Context>(
  ctx: Context,
  selectedContext: SelectedExtraContext,
  blobStore: ExtraContextBlobStore<Context> | undefined,
): Promise<string[]> {
  const read = await Promise.all(selectedContext.entries.map((entry) => readEntry(ctx, entry, blobStore)))
  const collected = uniqueTexts()
  for (const value of read) collected.add(value)
  for (const value of selectedContext.inlineText) collected.add(value)
  return collected.values
}
