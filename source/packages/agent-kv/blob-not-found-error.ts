/** Error marker and recovery guidance for transcript references to missing agent-store blobs. */

const MISSING_CONVERSATION_DATA =
  "This conversation can't be recovered because required data is absent. Start a new chat to continue."
const MAX_BLOB_IDS_IN_MESSAGE = 3
const SHORT_BLOB_ID_LENGTH = 12
const CAUSE_CHAIN_LIMIT = 10

function summarizeMissingIds(ids: readonly string[]): string {
  if (ids.length === 0) return ""
  const visibleIds = ids.slice(0, MAX_BLOB_IDS_IN_MESSAGE).map(id => id.slice(0, SHORT_BLOB_ID_LENGTH))
  if (ids.length === 1) return ` (missing blob ${visibleIds[0]})`
  const more = ids.length > visibleIds.length ? ", …" : ""
  return ` (${ids.length} blobs missing: ${visibleIds.join(", ")}${more})`
}

export class BlobNotFoundError extends Error {
  readonly isUsageError = true
  readonly isBlobNotFound = true
  readonly blobIdHexes: string[]

  constructor(blobIdHexes: readonly string[], options?: { cause?: unknown }) {
    super(
      `${MISSING_CONVERSATION_DATA}${summarizeMissingIds(blobIdHexes)}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "BlobNotFoundError"
    this.blobIdHexes = [...blobIdHexes]
  }
}

function isBlobNotFoundError(value: unknown): value is Error {
  if (!(value instanceof Error)) return false
  if (value instanceof BlobNotFoundError) return true
  const marked = value as Error & { isBlobNotFound?: boolean }
  return marked.isBlobNotFound === true || value.name === "BlobNotFoundError"
}

export function findBlobNotFoundError(error: unknown): Error | undefined {
  let candidate = error
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT; depth += 1) {
    if (candidate === null || candidate === undefined) return undefined
    if (isBlobNotFoundError(candidate)) return candidate
    if (typeof candidate !== "object" || !("cause" in candidate)) return undefined
    candidate = candidate.cause
  }
  return undefined
}
