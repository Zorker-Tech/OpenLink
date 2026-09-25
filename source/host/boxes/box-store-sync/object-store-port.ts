/**
 * The failure of a write that lost a race with another writer.
 *
 * The object store is written by more than one host, so a write can find that the key moved under it. That
 * is not a lost update: the content that won is preserved, and the loser is told where its own content was
 * kept and what it was written against, which is what lets the caller merge rather than overwrite.
 */

export class BoxStoreCanonicalWriteConflictError extends Error {
  readonly key: string
  readonly conflictRelPath: string | null
  readonly baseEtag: string | null
  readonly baselineSource: string | null

  constructor(args: { key: string; conflictRelPath?: string | null; baseEtag?: string | null; baselineSource?: string | null }) {
    super(args.conflictRelPath == null
      ? `canonical write for ${args.key} lost a concurrent-write race`
      : `agent-store write for ${args.key} lost a concurrent-write race; content preserved at ${args.conflictRelPath}`)
    this.name = "BoxStoreCanonicalWriteConflictError"
    this.key = args.key
    this.conflictRelPath = args.conflictRelPath ?? null
    this.baseEtag = args.baseEtag ?? null
    this.baselineSource = args.baselineSource ?? null
  }
}
